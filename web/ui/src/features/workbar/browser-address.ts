export function browserAddress(value: string, applicationOrigin?: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16_384) return null;
  const explicitScheme = /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmed);
  try {
    let url = new URL(explicitScheme ? trimmed : `https://${trimmed}`);
    if (
      !explicitScheme &&
      (url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost") ||
        url.hostname === "[::1]" ||
        /^127(?:\.\d{1,3}){3}$/u.test(url.hostname))
    )
      url = new URL(`http://${trimmed}`);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.origin === applicationOrigin
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
