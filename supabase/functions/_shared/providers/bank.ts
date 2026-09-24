// Bank linking provider (Plaid): fake + Plaid sandbox via REST.
import type { Env } from "./env.ts";

export interface BankAccountInfo { accountId: string; mask: string; name: string; institution: string; ownerNames: string[] }

export interface BankLinkProvider {
  name: "fake" | "plaid";
  createLinkToken(userId: string): Promise<string>;
  exchangePublicToken(publicToken: string): Promise<{ itemId: string; accessToken: string }>;
  /** /auth/get + /identity/get: the account and its owners' names. */
  getAccount(accessToken: string): Promise<BankAccountInfo>;
}

/**
 * Fake Plaid. Public token format: `public-fake-<institution>-<owner name>` (spaces as `_`), e.g.
 * `public-fake-First_Platypus_Bank-Ava_Harbor`. Omit the owner to use the default "Harbor Test User".
 */
export class FakeBankLink implements BankLinkProvider {
  name = "fake" as const;
  async createLinkToken(userId: string) { return `link-sandbox-fake-${userId.slice(0, 8)}`; }
  async exchangePublicToken(publicToken: string) {
    if (!publicToken.startsWith("public-fake-")) throw new Error("invalid public token");
    return { itemId: `item-${publicToken.slice(12)}`, accessToken: `access-fake-${publicToken.slice(12)}` };
  }
  async getAccount(accessToken: string): Promise<BankAccountInfo> {
    const [inst, owner] = accessToken.replace("access-fake-", "").split("-");
    let h = 0;
    for (const c of accessToken) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return {
      accountId: `acc-${h.toString(16)}`,
      mask: String(h % 10_000).padStart(4, "0"),
      name: "Plaid Checking",
      institution: (inst || "First_Platypus_Bank").replaceAll("_", " "),
      ownerNames: [(owner || "Harbor_Test_User").replaceAll("_", " ")],
    };
  }
}

export class PlaidSandbox implements BankLinkProvider {
  name = "plaid" as const;
  constructor(private env: Env) {}
  private async call(path: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`https://sandbox.plaid.com${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.env.PLAID_CLIENT_ID, secret: this.env.PLAID_SECRET, ...body }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`plaid ${path}: ${json?.error_message ?? res.status}`);
    return json;
  }
  async createLinkToken(userId: string) {
    const r = await this.call("/link/token/create", {
      user: { client_user_id: userId }, client_name: "Harbor (test)", products: ["auth", "identity"], country_codes: ["US"], language: "en",
    });
    return r.link_token as string;
  }
  async exchangePublicToken(publicToken: string) {
    const r = await this.call("/item/public_token/exchange", { public_token: publicToken });
    return { itemId: r.item_id as string, accessToken: r.access_token as string };
  }
  async getAccount(accessToken: string): Promise<BankAccountInfo> {
    const auth = await this.call("/auth/get", { access_token: accessToken });
    const acct = auth.accounts.find((a: any) => a.subtype === "checking") ?? auth.accounts[0];
    const ident = await this.call("/identity/get", { access_token: accessToken, options: { account_ids: [acct.account_id] } });
    const owners = (ident.accounts?.[0]?.owners ?? []).flatMap((o: any) => o.names ?? []);
    return { accountId: acct.account_id, mask: acct.mask ?? "0000", name: acct.name, institution: auth.item?.institution_id ?? "Plaid Sandbox", ownerNames: owners };
  }
}
