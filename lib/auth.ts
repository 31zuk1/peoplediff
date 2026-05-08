import { timingSafeEqual } from "node:crypto";

export function isAuthorizedBearer(request: Request, expectedToken: string | undefined) {
  const expected = expectedToken?.trim();
  if (!expected) return false;

  const supplied = bearerToken(request) ?? request.headers.get("x-peoplediff-admin-token")?.trim();
  if (!supplied) return false;

  return timingSafeStringEqual(supplied, expected);
}

export function isAuthorizedAdminRequest(request: Request) {
  if (!process.env.VERCEL && !process.env.PEOPLEDIFF_ADMIN_TOKEN) return true;
  return isAuthorizedBearer(request, process.env.PEOPLEDIFF_ADMIN_TOKEN);
}

export function bearerToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim();
}

function timingSafeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
