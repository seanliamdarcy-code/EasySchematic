import { randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { tokensMatch } from "./security.js";

type Grant = { clientId: string; params: AuthorizationParams; expires: number; consentExpires?: number };
const secret = () => randomBytes(32).toString("hex");
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Single-workstation OAuth grants; restarting revokes all connections. */
export class GrokAuth implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private pending = new Map<string, Grant>();
  private codes = new Map<string, Grant>();
  private access = new Map<string, AuthInfo>();
  private refresh = new Map<string, Grant>();
  private attempts: number[] = [];
  constructor(private pairingToken: string, readonly resource: URL) {}

  readonly clientsStore = {
    getClient: (id: string) => this.clients.get(id),
    registerClient: (input: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull => {
      if (!input.redirect_uris.length || !input.redirect_uris.every(uri => {
        try {
          const u = new URL(uri);
          return u.protocol === "https:" && !u.username && !u.password && !u.hash &&
            (u.hostname === "grok.com" || u.hostname.endsWith(".grok.com") || u.hostname === "x.ai" || u.hostname.endsWith(".x.ai"));
        } catch { return false; }
      })) throw new InvalidClientMetadataError("Only HTTPS Grok/xAI callbacks are supported.");
      if (this.clients.size >= 100) throw new InvalidClientMetadataError("Client limit reached. Restart the connector.");
      const client = { ...input, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
      this.clients.set(client.client_id, client);
      return client;
    },
  };

  private cleanup() {
    const now = Date.now();
    for (const map of [this.pending, this.codes, this.refresh]) for (const [key, grant] of map) if (grant.expires <= now) map.delete(key);
    for (const [key, info] of this.access) if ((info.expiresAt ?? 0) * 1000 <= now) this.access.delete(key);
  }
  private checkResource(resource?: URL) {
    if (resource && resource.href !== this.resource.href) throw new InvalidGrantError("Incorrect MCP resource.");
  }
  private getGrant(map: Map<string, Grant>, key: string, clientId: string): Grant {
    this.cleanup();
    const grant = map.get(key);
    if (!grant || grant.clientId !== clientId) throw new InvalidGrantError("Grant expired or invalid.");
    return grant;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.cleanup();
    this.checkResource(params.resource);
    if (!client.redirect_uris.includes(params.redirectUri) || !params.codeChallenge) throw new InvalidGrantError("Invalid redirect or missing PKCE.");
    if (params.scopes?.some(scope => scope !== "schematic")) throw new InvalidScopeError("Only schematic scope is supported.");
    if (this.pending.size >= 100) throw new InvalidGrantError("Too many pending requests.");
    const id = secret();
    this.pending.set(id, { clientId: client.client_id, params: { ...params, scopes: ["schematic"] }, expires: Date.now() + 300_000 });
    // Preserve the consent POST's Origin, and permit only this registered OAuth callback.
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(params.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'` });
    res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Connect Grok to EasySchematic</title><style>body{font:16px system-ui;max-width:620px;margin:8vh auto;padding:24px}input,button{font:inherit;padding:12px;margin-top:16px}input{width:90%}button{cursor:pointer}</style></head><body><h1>Connect Grok to EasySchematic</h1><p>Client: ${escapeHtml(client.client_name || "Grok")}</p><p>Allow this client to read Jetbuilt project kits and read/edit the schematic paired on this workstation. Shared library publication still requires human review in the editor.</p><p>Callback: ${escapeHtml(new URL(params.redirectUri).origin)}</p><p>Run <code>mcp-server/copy-pairing-token.ps1</code> on your workstation and paste the existing pairing token below. This request expires in five minutes.</p><form method="post" action="/consent"><input type="hidden" name="request" value="${id}"><label>Existing EasySchematic pairing token<input type="password" name="token" autocomplete="off" required></label><br><button name="decision" value="allow">Allow Grok access</button> <button name="decision" value="deny" formnovalidate>Cancel</button></form></body></html>`);
  }

  consent(id: string, token: string, allow: boolean): string {
    const now = Date.now();
    this.attempts = this.attempts.filter(t => t > now - 60_000);
    if (this.attempts.length >= 20) throw new InvalidGrantError("Too many attempts. Wait one minute.");
    this.attempts.push(now);
    this.cleanup();
    const grant = this.pending.get(id);
    if (!grant) throw new InvalidGrantError("Authorization request expired.");
    if (allow && !tokensMatch(token, this.pairingToken)) throw new InvalidGrantError("Pairing token did not match.");
    const redirect = new URL(grant.params.redirectUri);
    if (grant.params.state) redirect.searchParams.set("state", grant.params.state);
    if (allow) {
      const code = secret();
      this.codes.set(code, { ...grant, expires: now + 60_000 });
      redirect.searchParams.set("code", code);
    } else redirect.searchParams.set("error", "access_denied");
    this.pending.delete(id);
    return redirect.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    return this.getGrant(this.codes, code, client.client_id).params.codeChallenge;
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const grant = this.getGrant(this.codes, code, client.client_id);
    this.checkResource(resource);
    if (redirectUri !== grant.params.redirectUri) throw new InvalidGrantError("Redirect mismatch.");
    this.codes.delete(code);
    return this.issue(grant);
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    const grant = this.getGrant(this.refresh, token, client.client_id);
    this.checkResource(resource);
    if (scopes?.some(scope => scope !== "schematic")) throw new InvalidScopeError("Cannot expand scope.");
    this.refresh.delete(token);
    return this.issue(grant);
  }
  private issue(grant: Grant): OAuthTokens {
    this.cleanup();
    if (this.access.size >= 1000 || this.refresh.size >= 1000) throw new InvalidGrantError("Token limit reached.");
    const accessToken = secret(), refreshToken = secret();
    const consentExpires = grant.consentExpires ?? Date.now() + 86_400_000;
    const expiresAt = Math.floor(Math.min(Date.now() + 3_600_000, consentExpires) / 1000);
    this.access.set(accessToken, { token: accessToken, clientId: grant.clientId, scopes: ["schematic"], expiresAt, resource: this.resource });
    // A refresh cannot extend the original 24-hour workstation consent.
    this.refresh.set(refreshToken, { ...grant, consentExpires, expires: consentExpires });
    return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: expiresAt - Math.floor(Date.now() / 1000), scope: "schematic" };
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.cleanup();
    const info = this.access.get(token);
    if (!info) throw new InvalidTokenError("Access token expired or invalid.");
    return info;
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    if (this.access.get(request.token)?.clientId === client.client_id) this.access.delete(request.token);
    if (this.refresh.get(request.token)?.clientId === client.client_id) this.refresh.delete(request.token);
  }
}
