import { Node, Context, NodeValue, resolve, resolveAll, resolveObj, randomString } from "@jexs/core";

// Types
interface OAuthProvider {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  scopes: string[];
  userIdField?: string;
  userEmailField?: string;
  userNameField?: string;
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

// Module-level state
const providers: Map<string, OAuthProvider> = new Map();

/**
 * OAuthNode - Handles OAuth authentication flows in JSON.
 *
 * { "oauth": "configure", "provider": "google", "clientId": "...", "clientSecret": "..." }
 * { "oauth": "authUrl", "provider": "google", "redirectUri": "http://...", "state": "..." }
 * { "oauth": "exchange", "provider": "google", "code": "...", "redirectUri": "..." }
 * { "oauth": "refresh", "provider": "google", "refreshToken": "..." }
 * { "oauth": "userInfo", "provider": "google", "accessToken": "..." }
 * { "oauth": "state" }
 * { "oauth": "providers" }
 */
export class OAuthNode extends Node {
  /**
   * OAuth 2.0 flow helpers. Operations: `"configure"`, `"authUrl"`, `"exchange"`, `"refresh"`, `"userInfo"`, `"state"`, `"providers"`.
   * Built-in providers: `google`, `github`, `facebook`, `discord`, `twitter`, `microsoft`.
   *
   * @example
   * { "oauth": "authUrl", "provider": "google", "redirectUri": { "var": "$redirectUri" } }
   */
  oauth(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.oauth, context, operation => {
      switch (String(operation)) {
        case "configure":
          return doConfigure(def, context);
        case "authUrl":
          return doAuthUrl(def, context);
        case "exchange":
          return doExchange(def, context);
        case "refresh":
          return doRefresh(def, context);
        case "userInfo":
          return doUserInfo(def, context);
        case "state":
          return doGenerateState(def, context);
        case "providers":
          return doListProviders(def, context);
        default:
          console.error(`[OAuth] Unknown operation: ${operation}`);
          return null;
      }
    });
  }
}

function doConfigure(def: Record<string, unknown>, context: Context): unknown {
  return resolveObj(def, context, r => {
    const name = String(r.provider);
    const clientId = String(r.clientId);
    const clientSecret = String(r.clientSecret);

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
      });
    }

    console.log(`[OAuth] Configured provider: ${name}`);
    return { type: "oauth", action: "configure", provider: name };
  });
}

function doAuthUrl(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll(
    [def.provider, def.redirectUri, def.scopes ?? null, def.state ?? null, def.prompt ?? null, def.accessType ?? null],
    context,
    ([providerRaw, redirectUriRaw, scopesRaw, stateRaw, promptRaw, accessTypeRaw]) => {
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

      const state = def.state ? String(stateRaw) : randomString(32);
      params.set("state", state);
      if (def.prompt) params.set("prompt", String(promptRaw));
      if (def.accessType) params.set("access_type", String(accessTypeRaw));

      return `${config.authorizeUrl}?${params.toString()}`;
    },
  );
}

function doExchange(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.provider, def.code, def.redirectUri], context, async ([providerRaw, codeRaw, redirectUriRaw]) => {
    const provider = String(providerRaw);
    const code = String(codeRaw);
    const redirectUri = String(redirectUriRaw);
    const config = providers.get(provider);

    if (!config) throw new Error(`Provider "${provider}" not configured`);

    try {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });

      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });

      if (!response.ok)
        throw new Error(`Token exchange failed: ${await response.text()}`);

      const data = (await response.json()) as Record<string, unknown>;
      return {
        success: true,
        accessToken: String(data.access_token),
        refreshToken: data.refresh_token
          ? String(data.refresh_token)
          : undefined,
        tokenType: String(data.token_type ?? "Bearer"),
        expiresIn: data.expires_in ? Number(data.expires_in) : undefined,
        expiresAt: data.expires_in
          ? Date.now() + Number(data.expires_in) * 1000
          : undefined,
      };
    } catch (error) {
      const e = error as Error;
      console.error(`[OAuth] Exchange failed:`, e.message);
      return { success: false, error: e.message };
    }
  });
}

function doRefresh(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.provider, def.refreshToken], context, async ([providerRaw, refreshTokenRaw]) => {
    const provider = String(providerRaw);
    const refreshToken = String(refreshTokenRaw);
    const config = providers.get(provider);

    if (!config) throw new Error(`Provider "${provider}" not configured`);

    try {
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      });

      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });

      if (!response.ok)
        throw new Error(`Token refresh failed: ${await response.text()}`);

      const data = (await response.json()) as Record<string, unknown>;
      return {
        success: true,
        accessToken: String(data.access_token),
        refreshToken: data.refresh_token
          ? String(data.refresh_token)
          : refreshToken,
        tokenType: String(data.token_type ?? "Bearer"),
        expiresIn: data.expires_in ? Number(data.expires_in) : undefined,
      };
    } catch (error) {
      const e = error as Error;
      console.error(`[OAuth] Refresh failed:`, e.message);
      return { success: false, error: e.message };
    }
  });
}

function doUserInfo(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.provider, def.accessToken], context, async ([providerRaw, accessTokenRaw]) => {
    const provider = String(providerRaw);
    const accessToken = String(accessTokenRaw);
    const config = providers.get(provider);

    if (!config) throw new Error(`Provider "${provider}" not configured`);
    if (!config.userInfoUrl)
      throw new Error(`Provider "${provider}" has no userInfoUrl`);

    try {
      const response = await fetch(config.userInfoUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (!response.ok)
        throw new Error(`Failed to get user info: ${await response.text()}`);

      const data = (await response.json()) as Record<string, unknown>;
      const getNested = (
        obj: Record<string, unknown>,
        dotPath: string,
      ): unknown => {
        return dotPath.split(".").reduce((curr: unknown, key) => {
          if (curr && typeof curr === "object")
            return (curr as Record<string, unknown>)[key];
          return undefined;
        }, obj);
      };

      return {
        success: true,
        id: String(getNested(data, config.userIdField ?? "id") ?? ""),
        email: getNested(data, config.userEmailField ?? "email") as
          | string
          | undefined,
        name: getNested(data, config.userNameField ?? "name") as
          | string
          | undefined,
        picture: (data.picture ?? data.avatar_url ?? data.avatar) as
          | string
          | undefined,
        raw: data,
      };
    } catch (error) {
      const e = error as Error;
      console.error(`[OAuth] getUserInfo failed:`, e.message);
      return { success: false, error: e.message };
    }
  });
}

function doGenerateState(def: Record<string, unknown>, context: Context): unknown {
  const doGenerate = (length: number) => {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % chars.length];
    }
    return result;
  };

  if (!def.length) return doGenerate(32);
  return resolve(def.length, context, lengthRaw => doGenerate(Number(lengthRaw)));
}

function doListProviders(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.builtin ?? null, context, builtinRaw => {
    if (builtinRaw) return Object.keys(PROVIDERS);
    return [...providers.keys()];
  });
}
