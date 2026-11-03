// Starts the "Pionex sync" GitHub workflow from the Worker's cron.
// GitHub's own schedule is best-effort: it starts late and skips runs. The Worker's cron runs on time, so it asks GitHub
// to run the workflow. Pionex itself still answers only GitHub's addresses, never the Worker's.
//
// Settings (Cloudflare, never in this repo):
//   GITHUB_DISPATCH_TOKEN   secret. A fine-grained token for THIS repository only, with the permission
//                           "Actions: Read and write" and nothing else.
//   GITHUB_REPOSITORY       plain variable, for example "owner/Portfolio-Tracker-PWA".
// Without both, nothing is sent.

const WORKFLOW_FILE = 'pionex-sync.yml';
const REF = 'main';

export async function dispatchPionexWorkflow(env, fetchImpl = fetch) {
  if (!env.GITHUB_DISPATCH_TOKEN || !env.GITHUB_REPOSITORY) return null;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'portfolio-tracker-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: REF }),
      signal: AbortSignal.timeout(10000),
    });
    // GitHub answers 204 with no body. The message never contains the token.
    return response.status === 204
      ? { broker: 'GitHub (Pionex)', ok: true, message: 'Pionex workflow started.' }
      : { broker: 'GitHub (Pionex)', ok: false, message: `GitHub refused to start the Pionex workflow (status ${response.status}). Check GITHUB_DISPATCH_TOKEN and GITHUB_REPOSITORY.` };
  } catch (error) {
    return { broker: 'GitHub (Pionex)', ok: false, message: `GitHub could not be reached (${String(error.message ?? 'unknown error').slice(0, 80)}).` };
  }
}
