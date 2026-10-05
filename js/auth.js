// Microsoft sign-in (MSAL.js, loaded from the CDN as window.msal).
export const DEFAULT_SCOPES = ['User.Read', 'Sites.ReadWrite.All', 'Mail.Send'];

export async function createAuth(cfg) {
  const redirectUri = cfg.redirectUri || (location.origin + location.pathname);
  const pca = new msal.PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId || 'organizations'}`,
      redirectUri,
      postLogoutRedirectUri: redirectUri,
      navigateToLoginRequestUrl: false,
    },
    cache: { cacheLocation: 'localStorage' },
  });
  await pca.initialize();
  const result = await pca.handleRedirectPromise();
  const account = (result && result.account) || pca.getActiveAccount() || pca.getAllAccounts()[0] || null;
  if (account) pca.setActiveAccount(account);

  return {
    account,
    login: () => pca.loginRedirect({ scopes: DEFAULT_SCOPES, prompt: 'select_account' }),
    logout: () => pca.logoutRedirect({ account }),
    async getToken(scopes = DEFAULT_SCOPES) {
      try {
        const r = await pca.acquireTokenSilent({ scopes, account });
        return r.accessToken;
      } catch (e) {
        if (e instanceof msal.InteractionRequiredAuthError || e instanceof msal.BrowserAuthError) {
          // Redirects away to sign in / consent; the page reloads afterwards.
          await pca.acquireTokenRedirect({ scopes, account });
          return new Promise(() => {});
        }
        throw e;
      }
    },
  };
}
