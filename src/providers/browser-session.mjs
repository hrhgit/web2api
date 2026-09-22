import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";
import { ProviderError } from "./provider.mjs";

// One persistent profile owner, separate pages per job. Releasing one job must
// never close the browser underneath another job (including on cancellation).
export class BrowserPagePool {
  #serial = Promise.resolve();
  #context = null;
  #leases = 0;
  constructor(settings, options) { this.settings = settings; this.options = options; }
  #exclusive(task) {
    const next = this.#serial.catch(() => {}).then(task);
    this.#serial = next;
    return next;
  }
  acquire() {
    return this.#exclusive(async () => {
      let page;
      if (!this.#context) {
        const session = await launchBrowser(this.settings, this.options);
        this.#context = session.context;
        page = session.page;
      } else {
        page = await this.#context.newPage();
      }
      this.#leases++;
      let released = false;
      return { page, release: () => this.#exclusive(async () => {
        if (released) return;
        released = true;
        await page.close().catch(() => {});
        if (--this.#leases === 0) {
          const context = this.#context;
          this.#context = null;
          await context.close();
        }
      }) };
    });
  }
}

export async function minimizeBrowserWindow(context, page, { displayName } = {}) {
  let session;
  try {
    session = await context.newCDPSession(page);
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    const { bounds } = await session.send("Browser.getWindowBounds", { windowId });
    if (bounds.windowState !== "minimized") throw new Error("Browser window did not enter the minimized state.");
  } catch (error) {
    throw new ProviderError(
      "background_window_unavailable",
      `${displayName || "This provider"}'s background browser window could not be minimized. No prompt was submitted.`,
      { cause: error },
    );
  } finally {
    await session?.detach?.().catch(() => {});
  }
}

export async function launchBrowser(settings, { headed = false, background = false, displayName } = {}) {
  await mkdir(settings.profileDirectory, { recursive: true, mode: 0o700 });
  let context;
  try {
    context = await chromium.launchPersistentContext(settings.profileDirectory, {
      ...(settings.executablePath ? { executablePath: settings.executablePath } : { channel: settings.channel }),
      headless: !(headed || background),
      args: [`--profile-directory=${settings.profileName}`],
      ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);
    const page = context.pages()[0] || await context.newPage();
    if (background) await minimizeBrowserWindow(context, page, { displayName });
    return { context, page };
  } catch (error) {
    await context?.close().catch(() => {});
    if (/ProcessSingleton|SingletonLock|profile.*in use|user data directory is already in use/iu.test(error.message)) {
      throw new ProviderError("profile_busy", `${displayName}'s web2api browser profile is already in use. Close its login window or wait for the active request.`, { cause: error });
    }
    if (/executable.*(doesn't exist|does not exist)|not found at|distribution.*not found/iu.test(error.message)) {
      throw new ProviderError("browser_missing", "The configured browser executable could not be found.", { cause: error });
    }
    throw error;
  }
}
