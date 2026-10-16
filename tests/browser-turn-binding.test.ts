import { expect, test } from "bun:test";
import { chromium, type Locator, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import { readFileSync } from "node:fs";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("CodeMirror language invalidates the response cache and incomplete code is not delivered", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(new URL("./fixtures/chatgpt-codemirror-reply-2026-10-11.html", import.meta.url), "utf8"));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const cache = {};
    const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
    expect(chatGptHtmlToMarkdown((await observe()).fullHtml)).toContain("```python\nprint(1)\n```");
    await page.locator(".cm-content").evaluate(editor => editor.setAttribute("data-language", "text"));
    expect(chatGptHtmlToMarkdown((await observe()).fullHtml)).toContain("```text\nprint(1)\n```");
    await page.locator(".cm-content").evaluate(editor => {
      const gap = document.createElement("div");
      gap.style.height = "200px";
      editor.appendChild(gap);
    });
    await expect(observe()).rejects.toThrow("one complete set of code lines");
  } finally { await browser.close(); }
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("paragraph identity survives file preview movement in both response layouts", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    for (const root of ['class="markdown"', 'data-markdown-text-style="assistant-message"']) {
      const page = await browser.newPage();
      await page.setContent(`<section id="turn"><div data-content-search-unit-key="answer">
        <h4 data-conversation-role="assistant"></h4><div id="answer" ${root}>
        <p>Report saved:</p><p id="file">report.md</p><p id="tail">Done.</p>
      </div></div><button aria-label="Copy"></button></section>`);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const cache = {};
      const observe = () => worker.responseDomSnapshot(page.locator("#turn"), cache);
      const before = await observe();
      const buffer = new ChatGptMarkdownBuffer(undefined, 0);
      expect(buffer.observe(before.markdownSegments, 0)).toBe("Report saved:\n\nreport.md");
      await page.locator("#file").evaluate(file => { file.parentElement!.parentElement!.appendChild(file); });
      const moved = await observe();
      expect(moved.markdownSegments.at(-1).key).toBe(before.markdownSegments.at(-1).key);
      expect(buffer.observe(moved.markdownSegments, 1)).toBe("");
      await page.locator("#answer").evaluate(answer => { answer.innerHTML = answer.innerHTML; });
      buffer.observe((await observe()).markdownSegments, 2);
      expect(buffer.finish().markdown).toBe("Report saved:\n\nreport.md\n\nDone.");
      await page.locator("#tail").evaluate(tail => { tail.textContent = "A changed answer."; });
      buffer.observe((await observe()).markdownSegments, 3);
      expect(() => buffer.finish()).toThrow();
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("activity tone and collapsed content invalidate the response cache", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(new URL("./fixtures/chatgpt-activity-summaries.html", import.meta.url), "utf8"));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const cache = {};
    const turn = page.locator("#turn");
    const observe = () => worker.responseDomSnapshot(turn, cache);
    const first = await observe();
    expect(first.traceBlocks.filter((block: any) => block.kind === "status")).toHaveLength(10);
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
    const summary = page.locator('[data-markdown-text-style="assistant-message"]')
      .filter({ has: page.getByText("status 1", { exact: true }) });
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "primary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("commentary");
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "tertiary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("status");
    await summary.evaluate(node => { node.parentElement!.hidden = true; });
    const collapsed = await observe();
    expect(collapsed.traceBlocks.some((block: any) => block.kind === "status" || block.kind === "commentary")).toBeFalse();
    expect(collapsed.visibleText).toBe("answer 1");
    await summary.evaluate(node => { node.parentElement!.hidden = false; });
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("preserves the accepted user identity across Activity's temporary fallback group", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read first.txt.\n\nReturn its contents.";
    // Captured on the installed launcher: the user group appears at Send, disappears
    // during Activity, then returns with the same ID and a rich-text user bubble.
    const user = '<div data-user-message-bubble><div data-search-result-target><p><span data-prompt-link-href="app://test">Codex Native</span> Read first.txt.<br>Return its contents.</p></div></div>';
    const answer = '<div data-content-search-unit-key="fallback-turn-0:2:assistant"><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>FIRST fixture-marker</p></div></div><div class="turn-action-controls"><button>Copy</button></div>';
    for (const scenario of ["same-user", "different-user", "competing-turn", "old-group-remains", "unfinished", "streaming"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="submitted">${user}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      await page.locator("main").evaluate(node => { node.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      expect(binding.identity).toBe("group:assistant:fallback-turn-0");
      const key = scenario === "different-user" ? "unrelated" : "submitted";
      const renderedUser = scenario === "different-user"
        ? `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${prompt}</div></div>`
        : user;
      const response = scenario === "unfinished" ? '<span hidden data-chatgpt-agent-turn-start></span>'
        : scenario === "streaming" ? answer.replace('<div class="turn-action-controls"><button>Copy</button></div>', "") : answer;
      let replacement = `<div data-turn-key="${key}">${renderedUser}${response}</div>`;
      if (scenario === "competing-turn") replacement += `<div data-turn-key="other">${user}</div>`;
      if (scenario === "old-group-remains") replacement += '<div data-turn-key="fallback-turn-0"></div>';
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, replacement);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (["same-user", "unfinished", "streaming"].includes(scenario)) {
        expect((await result).identity).toBe("group:assistant:submitted");
      } else {
        await expect(result).rejects.toThrow("another user turn");
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

// Execute the real observation/rebinding code against the reported renderer transition.
// No account, network requests, or model submissions are used.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("an exchange rekeys only with the exact submitted prompt and no competing turn", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      captureSubmissionBaseline(page: Page, submittedText?: string): Promise<unknown>;
      waitForNewAssistantTurn(page: Page, baseline: unknown, deadline: number): Promise<Binding>;
      reconcileAssistantTurnBinding(page: Page, baseline: unknown, binding: Binding): Promise<Binding>;
    };
    type Binding = { identity: string; locator: Locator; acceptedTurnIdentities: string[] };
    const prompt = "Explain one thing.\nKeep  two spaces.";
    const group = (key: string, text?: string, complete = false) => `<div data-turn-key="${key}">
      ${text === undefined ? "" : `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${text}</div><span aria-hidden="true">\u200b</span><button>Show more</button></div>`}
      <div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div>
      <div data-markdown-text-style="assistant-message"><p>Answer.</p></div></div>
      ${complete ? '<div class="turn-action-controls"><button>Copy</button></div>' : ""}</div>`;
    for (const scenario of ["matching", "history", "foreign", "prefix-only", "changed-spaces", "changed-edges", "two-turns", "old-group-remains", "unfinished", "no-prompt", "same-key"] as const) {
      const page = await browser.newPage();
      const history = scenario === "history" ? group("earlier", prompt, true) : "";
      await page.setContent(`<main>${history}</main>`);
      const baseline = await worker.captureSubmissionBaseline(page, scenario === "no-prompt" ? undefined : prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, history + group("optimistic"));
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000);
      expect(binding.identity).toBe("group:assistant:optimistic");
      const text = scenario === "foreign" ? "Different task."
        : scenario === "prefix-only" ? prompt + " Another request."
        : scenario === "changed-spaces" ? prompt.replace("  ", " ")
        : scenario === "changed-edges" ? " " + prompt : prompt;
      let html = history + group(scenario === "same-key" ? "optimistic" : "persisted", text, scenario !== "unfinished");
      if (scenario === "two-turns") html += group("foreign", prompt, true);
      if (scenario === "old-group-remains") html += '<div data-turn-key="optimistic"><div data-user-message-bubble>Earlier</div></div>';
      await page.locator("main").evaluate((node, next) => { node.innerHTML = next; }, html);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "matching" || scenario === "history" || scenario === "same-key" || scenario === "unfinished") {
        const rebound = await result;
        expect(rebound.identity).toBe(`group:assistant:${scenario === "same-key" ? "optimistic" : "persisted"}`);
        expect(await rebound.locator.count()).toBe(1);
      } else {
        await expect(result).rejects.toThrow();
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

// Reported on 6.1.9: a 50-90k character prompt sent to a fresh temporary chat shows no user
// bubble while generating (accepted by generation_running), then ChatGPT persists the exchange
// under a new key with a connector pill and/or a collapsed bubble once the answer completes.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a persisted exchange without an observed user ID rebinds across rendered-only prompt differences", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const prompt = `Summarize the task.\n\n${"<context>line of accumulated state</context>\n".repeat(400)}Return the checkpoint.`;
    const answer = '<div data-content-search-unit-key="persisted:assistant"><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>Checkpoint.</p></div></div><div class="turn-action-controls"><button>Copy</button></div>';
    // The inline compaction transport: a fixed contract, then the context JSON in a code fence.
    const fenced = `${"Contract sentence for the checkpoint.\n".repeat(60)}\`\`\`text\n<codex_context_json>\n${JSON.stringify({ messages: Array.from({ length: 200 }, (_, index) => `accumulated state ${index}:\n## ${index}\\. "done"`) })}\n</codex_context_json>\n\`\`\`\n<codex_transport_resume>\nProduce the checkpoint.\n</codex_transport_resume>`;
    const paragraphs = (text: string) => text.split("\n\n").map(part => `<p>${escape(part).replace(/\n/g, "<br>")}</p>`).join("");
    const bubble = (content: string) => `<div data-user-message-bubble><div data-search-result-target>${content}</div><button>Show more</button></div>`;
    const cases = {
      "connector-pill": [true, bubble(`<p><span data-prompt-link-href="app://test">Codex Native</span> ${paragraphs(prompt).slice(3)}`)],
      "collapsed": [true, bubble(`<div style="white-space:pre-wrap">${escape(prompt.slice(0, 2000))}</div>`)],
      "collapsed-with-history": [false, bubble(`<div style="white-space:pre-wrap">${escape(prompt.slice(0, 2000))}</div>`)],
      "collapsed-divergent": [false, bubble(`<div style="white-space:pre-wrap">${escape(prompt.slice(0, 1999) + "X")}</div>`)],
      "collapsed-too-short": [false, bubble(`<div style="white-space:pre-wrap">${escape(prompt.slice(0, 40))}</div>`)],
      "longer": [false, bubble(`<div style="white-space:pre-wrap">${escape(prompt + " Another request.")}</div>`)],
      "reworded": [false, bubble(`<div style="white-space:pre-wrap">${escape(prompt.slice(0, 2000).replace("accumulated", "different"))}</div>`)],
      "fenced-context": [true, bubble(`<p>${escape(fenced.split("```text")[0]!.trim())}</p><pre><div>text</div><button>Copy code</button><code>${escape(fenced.split("```text\n")[1]!.slice(0, 3000))}</code></pre>`), fenced],
      // Captured on 6.1.9: the composer doubles each backslash of the JSON-escaped context.
      "escaped-backslashes": [true, bubble(`<div style="white-space:pre-wrap">${escape(fenced.slice(0, 3000).replaceAll("\\", "\\\\"))}</div>`), fenced],
      // Captured on 6.1.9: a collapsed Full-mode turn shows the prompt's tail behind Show more.
      "collapsed-tail": [true, bubble(`<div style="white-space:pre-wrap">${escape(fenced.slice(-1200))}</div>`), fenced],
      "collapsed-tail-changed": [false, bubble(`<div style="white-space:pre-wrap">${escape(fenced.slice(-1200).replace("Produce", "Skip"))}</div>`), fenced],
      "fenced-context-changed": [false, bubble(`<p>${escape(fenced.split("```text")[0]!.trim())}</p><pre><div>text</div><button>Copy code</button><code>${escape(fenced.split("```text\n")[1]!.slice(0, 3000).replace("state", "other"))}</code></pre>`), fenced],
    } as const;
    for (const [scenario, [accepted, user, submitted = prompt]] of Object.entries(cases) as [string, readonly [boolean, string, string?]][]) {
      const page = await browser.newPage();
      const history = scenario === "collapsed-with-history"
        ? `<div data-turn-key="earlier">${bubble("Earlier")}${answer.replaceAll("persisted", "earlier")}</div>` : "";
      await page.setContent(`<main>${history}</main>`);
      const baseline = await worker.captureSubmissionBaseline(page, submitted);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, `${history}<div data-turn-key="optimistic"><span hidden data-chatgpt-agent-turn-start></span></div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("assistant_turn");
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      expect(binding.identity).toBe("group:assistant:optimistic");
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, `${history}<div data-turn-key="persisted">${user}${answer}</div>`);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (accepted) expect((await result).identity).toBe("group:assistant:persisted");
      else await expect(result).rejects.toThrow("another user turn");
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("binds captured Activity before an answer exists and recognizes uploaded native-button tiles", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/backend-api/files/process_upload_stream"
    ? new Response(JSON.stringify({ event: "file.processing.completed", file_id: "fixture-file" }) + "\n", { headers: { "content-type": "application/x-ndjson" } })
    : new Response("<main></main>", { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    await page.setContent('<main></main>');
    const baseline = await worker.captureSubmissionBaseline(page, "Prompt");
    const html = readFileSync(new URL("./fixtures/chatgpt-power-activity.html", import.meta.url), "utf8");
    await page.locator("main").evaluate((node, content) => { node.innerHTML = content; }, html);
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
    expect(binding.identity).toBe("group:assistant:activity");
    expect((await worker.responseDomSnapshot(binding.locator)).traceBlocks.some((block: { kind: string }) => block.kind === "commentary")).toBeTrue();
    for (const tile of ['button', 'div role="button"']) {
      await page.setContent(`<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="height:40px">Prompt</div>
        <input type="file" multiple><${tile} class="composer-attachment-surface" aria-label="codex-input-image-1.png">File</${tile.split(' ')[0]}>
        <button type="submit">Send</button></form>`);
      await page.locator('input[type="file"]').evaluate(input => {
        input.addEventListener("change", () => void fetch("/backend-api/files/process_upload_stream", {
          method: "POST", body: JSON.stringify({ file_name: "codex-input-image-1.png", file_id: "fixture-file" }),
        }));
      });
      await worker.attachFiles(page, { images: [{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }] });
      expect(await page.locator('input[type="file"]').evaluate(input => (input as HTMLInputElement).files?.[0]?.name)).toBe("codex-input-image-1.png");
    }
  } finally { await browser.close(); server.stop(true); }
}, 15_000);
