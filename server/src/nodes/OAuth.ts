import { createHash, randomBytes } from "crypto";
import { Node, Context, NodeValue, resolve, resolveAll, resolveFields, randomString, isObject, createHttpError } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { sessionData, setSessionData } from "./Session.js";
import { tokensEqual } from "./Crypto.js";

/** How the client credentials reach the token endpoint: as form fields, or as
 *  an HTTP Basic `Authorization` header (RFC 6749 §2.3.1), which some
 *  providers require. */
type TokenAuth = "body" | "basic";
const TOKEN_AUTH: readonly TokenAuth[] = ["body", "basic"];

function isTokenAuth(value: unknown): value is TokenAuth {
  return TOKEN_AUTH.some(t => t === value);
}

// Types
interface OAuthProvider {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  scopes: string[];
  tokenAuth?: TokenAuth;
  userIdField?: string;
  userEmailField?: string;
  userNameField?: string;
}

/** The tokens `exchange` and `refresh` return: the `_oauthTokens` shape. */
interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn?: number;
  expiresAt?: number;
}

/** A login `authUrl` started, kept in the session until `exchange` uses it. */
interface PendingLogin {
  state: string;
  redirectUri: string;
  /** PKCE (RFC 7636): sent as its S256 challenge, proven at the token endpoint. */
  verifier: string;
}

// Built-in provider configurations
const PROVIDERS: Record<
  string,
  Omit<OAuthProvider, "clientId" | "clientSecret">
> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    scopes: ["openid", "email", "profile"],
    userIdField: "id",
    userEmailField: "email",
    userNameField: "name",
  },
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scopes: ["read:user", "user:email"],
    userIdField: "id",
    userEmailField: "email",
    userNameField: "name",
  },
  facebook: {
    authorizeUrl: "https://www.facebook.com/v18.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v18.0/oauth/access_token",
    userInfoUrl: "https://graph.facebook.com/me?fields=id,name,email,picture",
    scopes: ["email", "public_profile"],
    userIdField: "id",
    userEmailField: "email",
    userNameField: "name",
  },
  discord: {
    authorizeUrl: "https://discord.com/api/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    userInfoUrl: "https://discord.com/api/users/@me",
    scopes: ["identify", "email"],
    userIdField: "id",
    userEmailField: "email",
    userNameField: "username",
  },
  twitter: {
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    userInfoUrl: "https://api.twitter.com/2/users/me",
    scopes: ["users.read", "tweet.read"],
    tokenAuth: "basic",
    userIdField: "data.id",
    userEmailField: "data.email",
    userNameField: "data.name",
  },
  microsoft: {
    authorizeUrl:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userInfoUrl: "https://graph.microsoft.com/v1.0/me",
    scopes: ["openid", "email", "profile"],
    userIdField: "id",
    userEmailField: "mail",
    userNameField: "displayName",
  },
};

/** Configured providers, credentials included, by name. */
type Providers = Map<string, OAuthProvider>;

// Shared sibling definitions, declared before the class so the static schema
// initializer can read them (a `const` is not hoisted).
const OAUTH_PROVIDER = {
  type: "string" as const,
  description: "Provider name (`\"google\"`, `\"github\"`, `\"facebook\"`, `\"discord\"`, `\"twitter\"`, `\"microsoft\"`).",
};
const OAUTH_CLIENT_ID = { type: "string" as const, description: "OAuth client ID." };
const OAUTH_CLIENT_SECRET = { type: "string" as const, description: "OAuth client secret." };
const OAUTH_REDIRECT_URI = { type: "string" as const, description: "Where the provider sends the user back (your callback route); `exchange` reuses it." };

/**
 * OAuthNode - Handles OAuth authentication flows in JSON.
 *
 * { "$oauth": "configure", "provider": "google", "clientId": "...", "clientSecret": "..." }
 * { "$oauth": "authUrl", "provider": "google", "redirectUri": "http://...", "state": "..." }
 * { "$oauth": "exchange" }
 * { "$oauth": "refresh", "provider": "google", "refreshToken": "..." }
 * { "$oauth": "userInfo", "provider": "google", "accessToken": "..." }
 * { "$oauth": "providers" }
 */
export class OAuthNode extends Node {
  static schemaDefs = {
    _oauthTokens: {
      type: "object",
      description: "The tokens a provider granted, as `exchange` and `refresh` return them.",
      properties: {
        accessToken: { type: "string", description: "Bearer token for the provider's API, e.g. `userInfo`." },
        refreshToken: { type: "string", description: "For `refresh`, when the provider issues one." },
        tokenType: { type: "string", description: "Usually `\"Bearer\"`." },
        expiresIn: { type: "number", description: "Seconds the access token lasts, when the provider says." },
        expiresAt: { type: "number", description: "When it expires, in ms since the epoch." },
      },
      required: ["accessToken", "tokenType"],
    },
    _oauthUser: {
      type: "object",
      description: "A user's profile as `userInfo` returns it: the common fields named the same for every provider, and the provider's own reply.",
      properties: {
        id: { type: "string", description: "The user's id at the provider." },
        email: { type: "string" },
        name: { type: "string" },
        picture: { type: "string", description: "Avatar URL, when the provider gives one." },
        raw: { type: "object", description: "The provider's whole reply." },
      },
      required: ["id", "raw"],
    },
  };

  static schema: JexsNodeSchema = {
    oauth: {
      type: "string",
      enum: [
        "configure",
        "authUrl",
        "exchange",
        "refresh",
        "userInfo",
        "providers",
      ],
      markdownDescription: "OAuth 2.0 flow helpers. The operation is the primary value.\nBuilt-in providers: `google`, `github`, `facebook`, `discord`, `twitter`, `microsoft`.",
      examples: [
        "{ \"$oauth\": \"authUrl\", \"provider\": \"google\", \"redirectUri\": { \"$var\": \"redirectUri\" } }",
      ],
      variants: {
        configure: {
          output: "null",
          markdownDescription: "Registers provider credentials.",
          siblings: {
            provider: OAUTH_PROVIDER,
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET,
            tokenAuth: {
              type: "string",
              enum: [...TOKEN_AUTH],
              description: "How the client credentials reach the token endpoint: `\"body\"` (form fields, the default) or `\"basic\"` (an HTTP Basic header, which X/Twitter requires and the built-in `twitter` uses).",
            },
          },
        },
        authUrl: {
          output: "string",
          markdownDescription: "Builds the provider authorization URL, with a `state` and a PKCE (S256) challenge. The login is kept in the user's session, starting one if needed, so `exchange` can finish it when the provider redirects back.",
          siblings: {
            provider: OAUTH_PROVIDER,
            redirectUri: OAUTH_REDIRECT_URI,
            state: { type: "string", description: "State to send instead of a random one." },
          },
        },
        exchange: {
          output: { $ref: "#/$defs/_oauthTokens" },
          outputDescription: "The tokens the provider granted. A refusal throws a 502, for `$catch`.",
          markdownDescription: "Finishes the login `authUrl` started in this browser's session: checks the callback's `state` (once: a missing, wrong or reused state fails with 403 before the code is spent), then exchanges the `code` for tokens with the same redirect URI and the PKCE verifier. In a callback route it needs no siblings.",
          examples: ["{ \"$oauth\": \"exchange\", \"$as\": \"tokens\" }"],
          siblings: {
            provider: { ...OAUTH_PROVIDER, description: `${OAUTH_PROVIDER.description} Only needed when this session has more than one login in progress.` },
            code: { type: "string", description: "Authorization code (default: the request's `code` query parameter)." },
            state: { type: "string", description: "State from the redirect (default: the request's `state` query parameter)." },
          },
        },
        refresh: {
          output: { $ref: "#/$defs/_oauthTokens" },
          outputDescription: "The new tokens; `refreshToken` stays the one passed in when the provider issues no new one. A refusal throws a 502.",
          markdownDescription: "Refreshes tokens using a `refreshToken`.",
          siblings: { provider: OAUTH_PROVIDER, refreshToken: { type: "string", description: "Refresh token." } },
        },
        userInfo: {
          output: { $ref: "#/$defs/_oauthUser" },
          outputDescription: "The user's profile, its common fields named the same for every provider. A refusal throws a 502.",
          markdownDescription: "Fetches the user profile for a bearer `accessToken`.",
          siblings: { provider: OAUTH_PROVIDER, accessToken: { type: "string", description: "Bearer token." } },
        },
        providers: {
          output: { type: "array", items: { type: "string" } },
          markdownDescription: "Returns the array of configured provider names.",
        },
      },
    },
  };

  /** This resolver's providers. An instance field, so one resolver's client
   *  secrets are never visible to, or replaced by, another's. */
  private readonly providers: Providers = new Map();

  oauth(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$oauth, context, operation => {
      switch (String(operation)) {
        case "configure":
          return doConfigure(this.providers, def, context);
        case "authUrl":
          return doAuthUrl(this.providers, def, context);
        case "exchange":
          return doExchange(this.providers, def, context);
        case "refresh":
          return doRefresh(this.providers, def, context);
        case "userInfo":
          return doUserInfo(this.providers, def, context);
        case "providers":
          return doListProviders(this.providers, def, context);
        default:
          console.error(`[OAuth] Unknown operation: ${operation}`);
          return null;
      }
    });
  }
}

function doConfigure(providers: Providers, def: Record<string, unknown>, context: Context): unknown {
  return resolveFields(def, context, r => {
    const name = String(r.provider);
    // Required: a credential that resolves to nothing must not become "undefined".
    if (r.clientId == null || r.clientSecret == null) {
      throw new Error(`OAuth provider "${name}" needs clientId and clientSecret`);
    }
    const clientId = String(r.clientId);
    const clientSecret = String(r.clientSecret);
    if (r.tokenAuth != null && !isTokenAuth(r.tokenAuth)) {
      throw new Error(`OAuth provider "${name}": tokenAuth must be ${TOKEN_AUTH.map(t => `"${t}"`).join(" or ")}`);
    }
    const tokenAuth = isTokenAuth(r.tokenAuth) ? r.tokenAuth : undefined;

    const builtin = PROVIDERS[name.toLowerCase()];

    if (builtin) {
      providers.set(name, {
        ...builtin,
        clientId,
        clientSecret,
        scopes: r.scopes
          ? Array.isArray(r.scopes)
            ? r.scopes.map(String)
            : [String(r.scopes)]
          : builtin.scopes,
        authorizeUrl: r.authorizeUrl ? String(r.authorizeUrl) : builtin.authorizeUrl,
        tokenUrl: r.tokenUrl ? String(r.tokenUrl) : builtin.tokenUrl,
        userInfoUrl: r.userInfoUrl ? String(r.userInfoUrl) : builtin.userInfoUrl,
        tokenAuth: tokenAuth ?? builtin.tokenAuth,
      });
    } else {
      const authorizeUrl = r.authorizeUrl ? String(r.authorizeUrl) : "";
      const tokenUrl = r.tokenUrl ? String(r.tokenUrl) : "";
      if (!authorizeUrl || !tokenUrl) {
        throw new Error(
          `Custom provider "${name}" requires authorizeUrl and tokenUrl`,
        );
      }
      const scopes = r.scopes ?? [];
      providers.set(name, {
        clientId,
        clientSecret,
        authorizeUrl,
        tokenUrl,
        userInfoUrl: r.userInfoUrl ? String(r.userInfoUrl) : undefined,
        scopes: Array.isArray(scopes) ? scopes.map(String) : [String(scopes)],
        tokenAuth,
      });
    }

    console.log(`[OAuth] Configured provider: ${name}`);
    return null;
  });
}

function doAuthUrl(providers: Providers, def: Record<string, unknown>, context: Context): unknown {
  return resolveAll(
    [def.provider, def.redirectUri, def.scopes ?? null, def.state ?? null, def.prompt ?? null, def.accessType ?? null],
    context,
    async ([providerRaw, redirectUriRaw, scopesRaw, stateRaw, promptRaw, accessTypeRaw]) => {
      const provider = String(providerRaw);
      const redirectUri = String(redirectUriRaw);
      const config = providers.get(provider);

      if (!config) throw new Error(`Provider "${provider}" not configured`);

      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: (scopesRaw
          ? (Array.isArray(scopesRaw) ? scopesRaw : [scopesRaw]).map(String)
          : config.scopes
        ).join(" "),
      });

      const login: PendingLogin = {
        state: stateRaw != null ? String(stateRaw) : randomString(32),
        redirectUri,
        verifier: randomBytes(32).toString("base64url"),
      };
      params.set("state", login.state);
      params.set("code_challenge", createHash("sha256").update(login.verifier).digest("base64url"));
      params.set("code_challenge_method", "S256");
      if (promptRaw != null) params.set("prompt", String(promptRaw));
      if (accessTypeRaw != null) params.set("access_type", String(accessTypeRaw));

      // The callback must come back to the browser that started the login, so
      // the login waits in its session, per provider, for `exchange` to finish.
      await setSessionData(context, { _oauth: { ...(await pendingLogins(context)), [provider]: login } });

      return `${config.authorizeUrl}?${params.toString()}`;
    },
  );
}

function doExchange(providers: Providers, def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.provider ?? null, def.code ?? null, def.state ?? null], context, async ([providerRaw, codeRaw, stateRaw]) => {
    const query = context.request?.query;
    const login = await takeLogin(context, providerRaw, stateRaw ?? query?.state);
    const config = providers.get(login.provider);
    if (!config) throw new Error(`Provider "${login.provider}" not configured`);

    // A provider redirects with `error` instead of a code when the user declines.
    const code = codeRaw ?? query?.code;
    if (code == null || code === "") {
      throw createHttpError(400, `OAuth login failed: ${String(query?.error ?? "the callback has no code")}`);
    }

    return tokenRequest(config, "exchange", {
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: login.redirectUri,
      code_verifier: login.verifier,
    });
  });
}

/** The logins `authUrl` started in this browser's session, by provider. */
async function pendingLogins(context: Context): Promise<Record<string, unknown>> {
  const pending = (await sessionData(context))._oauth;
  return isObject(pending) ? pending : {};
}

function isPendingLogin(value: unknown): value is PendingLogin {
  return isObject(value) && typeof value.state === "string"
    && typeof value.redirectUri === "string" && typeof value.verifier === "string";
}

/**
 * The login `authUrl` started in this browser's session, checked against the
 * callback's state and removed either way. A callback this browser never
 * started (a login CSRF: someone else's code, completed in the victim's
 * browser) or a replayed one is refused before the code is spent. Without a
 * `provider`, the one login in progress names its own.
 */
async function takeLogin(context: Context, providerRaw: unknown, submitted: unknown): Promise<PendingLogin & { provider: string }> {
  const logins = await pendingLogins(context);
  const names = Object.keys(logins);
  if (providerRaw == null && names.length > 1) {
    throw createHttpError(400, `More than one OAuth login is in progress (${names.join(", ")}); give "exchange" its "provider"`);
  }
  const provider = providerRaw != null ? String(providerRaw) : names[0];
  const login = provider !== undefined ? logins[provider] : undefined;
  if (provider !== undefined && login !== undefined) {
    const { [provider]: _used, ...rest } = logins;
    await setSessionData(context, { _oauth: rest });
  }
  if (provider === undefined || !isPendingLogin(login) || typeof submitted !== "string" || !tokensEqual(login.state, submitted)) {
    throw createHttpError(403, "OAuth state mismatch");
  }
  return { ...login, provider };
}

/**
 * POST to the provider's token endpoint with the client credentials, as form
 * fields or as a Basic header, and return the tokens it grants. A refusal
 * throws a 502. `refreshToken` stands in when the response carries no new one.
 */
async function tokenRequest(
  config: OAuthProvider,
  what: string,
  params: Record<string, string>,
  refreshToken?: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({ client_id: config.clientId, ...params });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (config.tokenAuth === "basic") {
    // RFC 6749 §2.3.1: each half is form-encoded before the pair is base64'd.
    const form = (s: string) => new URLSearchParams({ v: s }).toString().slice(2);
    headers.Authorization = `Basic ${Buffer.from(`${form(config.clientId)}:${form(config.clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_secret", config.clientSecret);
  }
  const response = await fetch(config.tokenUrl, { method: "POST", headers, body: body.toString() });
  const text = await response.text();
  const data = parseJsonObject(text);
  // Some providers (GitHub) answer a refused grant with a 200 and an `error`.
  if (!response.ok || typeof data?.access_token !== "string") {
    const reason = data?.error_description ?? data?.error ?? (text || response.statusText);
    throw createHttpError(502, `OAuth token ${what} failed: ${String(reason)}`);
  }
  const expiresIn = data.expires_in != null ? Number(data.expires_in) : undefined;
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : refreshToken,
    tokenType: typeof data.token_type === "string" ? data.token_type : "Bearer",
    expiresIn,
    expiresAt: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined,
  };
}

/** A JSON object body, or null when the text is not one. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function doRefresh(providers: Providers, def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.provider, def.refreshToken], context, async ([providerRaw, refreshTokenRaw]) => {
    const provider = String(providerRaw);
    const refreshToken = String(refreshTokenRaw);
    const config = providers.get(provider);

    if (!config) throw new Error(`Provider "${provider}" not configured`);

    return tokenRequest(config, "refresh", { grant_type: "refresh_token", refresh_token: refreshToken }, refreshToken);
  });
}

function doUserInfo(providers: Providers, def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.provider, def.accessToken], context, async ([providerRaw, accessTokenRaw]) => {
    const provider = String(providerRaw);
    const accessToken = String(accessTokenRaw);
    const config = providers.get(provider);

    if (!config) throw new Error(`Provider "${provider}" not configured`);
    if (!config.userInfoUrl)
      throw new Error(`Provider "${provider}" has no userInfoUrl`);

    const response = await fetch(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    const text = await response.text();
    const data = parseJsonObject(text);
    if (!response.ok || !data) {
      throw createHttpError(502, `OAuth user info failed: ${text || response.statusText}`);
    }

    // A dotted path into the profile, as the provider's field names give it.
    const at = (dotPath: string): unknown =>
      dotPath.split(".").reduce<unknown>((curr, key) => (isObject(curr) ? curr[key] : undefined), data);
    const stringOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
    const id = at(config.userIdField ?? "id");

    return {
      id: id == null ? "" : String(id),
      email: stringOf(at(config.userEmailField ?? "email")),
      name: stringOf(at(config.userNameField ?? "name")),
      picture: stringOf(data.picture ?? data.avatar_url ?? data.avatar),
      raw: data,
    };
  });
}

function doListProviders(providers: Providers, def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.builtin ?? null, context, builtinRaw => {
    if (builtinRaw) return Object.keys(PROVIDERS);
    return [...providers.keys()];
  });
}
