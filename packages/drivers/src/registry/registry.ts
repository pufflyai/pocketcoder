export interface RegistryCredential {
  server: string;
  username: string;
  password: string;
}

export type RegistryResolver = (reference: string, image: string) => Promise<RegistryCredential>;

export function dockerAuthConfig(credential: RegistryCredential) {
  return {
    auths: {
      [credential.server]: { auth: Buffer.from(`${credential.username}:${credential.password}`).toString("base64") },
    },
  };
}
