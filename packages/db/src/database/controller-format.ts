import seed from "../../assets/core-seed.json" with { type: "json" };

export const controllerDataFormat = {
  pglite: seed.pgliteVersion,
  postgres: seed.postgresVersion,
  migrations: seed.migrations,
};
