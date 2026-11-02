// What a release of this Worker receives from MDRN, and the few settings it reads.
//
// MDRN injects the MDRN_* bindings into every release of a service whose project has the
// products on. You never set them yourself, and they are never visible to a browser: they exist
// only inside this Worker. A database whose product is off has no URL and token here.

/** The service binding MDRN gives a release for every product call. */
export interface ProductsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  // Injected by MDRN.
  MDRN_PRODUCTS?: ProductsBinding;
  MDRN_PROJECT_ID?: string;
  MDRN_ENVIRONMENT?: string;
  MDRN_SQLITE_URL?: string;
  MDRN_SQLITE_TOKEN?: string;
  MDRN_POSTGRES_URL?: string;
  MDRN_POSTGRES_TOKEN?: string;
  MDRN_MAIL_URL?: string;
  MDRN_MAIL_TOKEN?: string;

  // Your own variables (console: Service -> Variables). All optional.
  /** `sqlite` or `postgres` to choose the database yourself; unset, the app picks (src/store.ts). */
  DATA_STORE?: string;
  /** Invitation emails one team may send per UTC day (default 20). */
  INVITE_DAILY_LIMIT?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SignedInUser;
  };
};

export interface SignedInUser {
  id: string;
  /** The MDRN identity token: proves the session to MDRN's own /v1/auth/me. */
  identityToken: string;
}
