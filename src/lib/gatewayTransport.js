// Use the native Function URL. Do not depend on wildcard rewrite parameters.
export function gatewayPath(upstreamURL) {
  const url = upstreamURL instanceof URL ? upstreamURL : new URL(upstreamURL);
  const query = new URLSearchParams(url.search);
  query.set('gateway_path', url.pathname.slice(1));
  return '/api/gateway?' + query.toString();
}
