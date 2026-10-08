export function authRedirect(path) {
  return new URL(path, window.location.origin).href;
}
