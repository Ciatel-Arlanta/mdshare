// Routes links the system hands to the app: pairing QR codes scanned with the
// camera app (mdshare://pair?...) and markdown files opened with "Open with".
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (/^mdshare:\/\/pair/i.test(path)) return `/link?url=${encodeURIComponent(path)}`;
    if (/^(content|file):\/\//i.test(path)) return `/open?uri=${encodeURIComponent(path)}`;
    return path;
  } catch {
    return '/';
  }
}
