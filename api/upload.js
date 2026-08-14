export default async function handler(request) {
  return Response.json({
    ok: true,
    msg: "pong",
    method: request.method,
    node: process.version,
  });
}
