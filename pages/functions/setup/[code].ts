// Serves the setup page with the code embedded in the URL
// GET /setup/:code → redirects to /setup.html?code=:code (client-side routing)
export const onRequestGet: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  const code = context.params.code as string;
  // Serve the setup.html with code as query param — the JS reads it
  return new Response(null, {
    status: 302,
    headers: { Location: `${url.origin}/setup.html?code=${code}` },
  });
};
