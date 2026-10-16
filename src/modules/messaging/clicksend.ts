import "server-only";

// ClickSend REST v3. Only a credentials check for now: sending arrives in v0.2
// and will go through an 'approve'-tier, labelled action like every send.
type Secrets = { username: string; api_key: string };

export async function testClickSend(secrets: Secrets): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
  try {
    const auth = Buffer.from(`${secrets.username}:${secrets.api_key}`).toString("base64");
    const res = await fetch("https://rest.clicksend.com/v3/account", {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "the username or API key is wrong" };
    if (!res.ok) return { ok: false, error: `ClickSend answered ${res.status}` };
    const body = (await res.json()) as { data?: { account_name?: string; username?: string; user_email?: string } };
    const d = body.data ?? {};
    return { ok: true, account: d.account_name || d.username || d.user_email || secrets.username };
  } catch {
    return { ok: false, error: "couldn't reach ClickSend" };
  }
}
