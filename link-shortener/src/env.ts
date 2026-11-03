// What a release of this Worker receives from MDRN. MDRN injects the MDRN_* bindings into every
// release of a service whose project has SQLite on. You never set them yourself, and they are
// never visible to a browser: they exist only inside this Worker.

/** The service binding MDRN gives a release for every product call. */
export interface ProductsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  MDRN_PRODUCTS?: ProductsBinding;
  MDRN_PROJECT_ID?: string;
  MDRN_ENVIRONMENT?: string;
  MDRN_SQLITE_URL?: string;
  MDRN_SQLITE_TOKEN?: string;
}

/** Hono's environment type for this app: the bindings above plus what middleware sets. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: SignedInUser;
  };
};

/** Who is calling: a browser signed in through MDRN. */
export interface SignedInUser {
  id: string;
}
