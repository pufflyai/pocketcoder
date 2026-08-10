export function isAbsolutePath(value: string) {
  return value.startsWith("/") && ![...value].some((character) => character.codePointAt(0) === 0);
}
export const SECRET_ENV_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
export const SECRET_REFERENCE_PREFIX = "secretRef:";
