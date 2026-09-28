import { ProviderError } from "./provider.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function modelOptionId(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 128);
}

function error(code, message, cause) {
  return new ProviderError(code, message, cause ? { cause } : {});
}

async function firstVisibleLocator(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).filter({ visible: true });
      if (await locator.count()) return locator.first();
    }
    await page.waitForTimeout(100);
  }
  return null;
}

async function visibleOptions(page, optionSelector) {
  return page.evaluate((selector) => {
    const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
    const normalize = (value) => String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const optionId = (value) => normalize(value).toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 128);
    const labelFor = (node) => {
      const explicit = ["data-web2api-model-label", "data-model-label", "aria-label", "title"]
        .map((name) => normalize(node.getAttribute(name))).find(Boolean);
      if (explicit) return explicit;
      return (node.innerText || node.textContent || "").split(/\r?\n/u).map(normalize).find(Boolean) || "";
    };
    const idFor = (node, label) => {
      const raw = ["data-web2api-model-id", "data-model-id", "data-value"]
        .map((name) => normalize(node.getAttribute(name))).find(Boolean);
      return optionId(raw || label);
    };
    return [...document.querySelectorAll(selector)].filter(visible).map((node, index) => {
      const label = labelFor(node);
      return {
        index,
        id: idFor(node, label),
        label,
        selected: node.getAttribute("aria-checked") === "true" || node.getAttribute("aria-selected") === "true" ||
          node.getAttribute("data-selected") === "true" || node.getAttribute("data-state") === "active",
        available: !(node instanceof HTMLButtonElement && node.disabled) && node.getAttribute("aria-disabled") !== "true",
      };
    }).filter((entry) => entry.id && entry.label);
  }, optionSelector);
}

function validateOptions(options, displayName) {
  if (!options.length) {
    throw error("model_selector_unavailable", `${displayName}'s model picker exposed no selectable options. No prompt was submitted.`);
  }
  const ids = new Set();
  for (const option of options) {
    if (ids.has(option.id)) {
      throw error("model_selector_unavailable", `${displayName}'s model picker exposed ambiguous options. No prompt was submitted.`);
    }
    ids.add(option.id);
  }
  return options;
}

async function pickerSummary(picker) {
  return picker.evaluate((node) => {
    const normalize = (value) => String(value || "").normalize("NFKC").replace(/\s+/gu, " ").trim();
    const optionId = (value) => normalize(value).toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 128);
    const ariaLabel = normalize(node.getAttribute("aria-label"));
    const announcedCurrent = /\bcurrently\s+(.+)$/iu.exec(ariaLabel)?.[1] || "";
    const label = [normalize(node.getAttribute("data-web2api-model-label")), normalize(node.getAttribute("data-model-label")), announcedCurrent,
      ariaLabel, normalize(node.getAttribute("title"))]
      .find(Boolean) ||
      (node.innerText || node.textContent || "").split(/\r?\n/u).map(normalize).find(Boolean) || "";
    const rawId = ["data-web2api-model-id", "data-model-id", "data-value"]
      .map((name) => normalize(node.getAttribute(name))).find(Boolean);
    return { id: optionId(rawId || label), label };
  });
}

function summaryMatchesOption(summary, option) {
  const summaryLabel = normalizeText(summary.label).toLowerCase();
  const optionLabel = normalizeText(option.label).toLowerCase();
  return option.id === summary.id || optionLabel === summaryLabel || optionLabel.endsWith(` ${summaryLabel}`);
}

async function dismiss(page) {
  await page.keyboard.press("Escape").catch(() => {});
}

async function openPicker(page, config, timeoutMs) {
  const picker = await firstVisibleLocator(page, config.pickerSelectors, timeoutMs);
  if (!picker) {
    throw error("model_selector_unavailable", `${config.displayName}'s model picker was not available. No prompt was submitted.`);
  }
  let options = await visibleOptions(page, config.optionSelector);
  let openedHere = false;
  if (!options.length) {
    try {
      await picker.click({ timeout: timeoutMs });
    } catch (cause) {
      throw error("model_selector_unavailable", `${config.displayName}'s model picker could not be opened. No prompt was submitted.`, cause);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      options = await visibleOptions(page, config.optionSelector);
      if (options.length) break;
      await page.waitForTimeout(100);
    }
    openedHere = true;
  }
  return { picker, options: validateOptions(options, config.displayName), openedHere };
}

async function currentSelection(page, config, timeoutMs) {
  const { picker, options, openedHere } = await openPicker(page, config, timeoutMs);
  try {
    const selected = options.find((option) => option.selected);
    if (selected) return selected;
    const summary = await pickerSummary(picker);
    return options.find((option) => summaryMatchesOption(summary, option)) || null;
  } finally {
    if (openedHere) await dismiss(page);
  }
}

export async function discoverModelOptions(page, config, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { picker, options, openedHere } = await openPicker(page, config, timeoutMs);
  try {
    const summary = await pickerSummary(picker);
    const selected = options.find((option) => option.selected) || options.find((option) => summaryMatchesOption(summary, option));
    return options.map(({ id, label, selected: optionSelected, available }) => ({
      id,
      label,
      selected: optionSelected || selected?.id === id,
      available,
    }));
  } finally {
    if (openedHere) await dismiss(page);
  }
}

export async function selectModelOption(page, requestedId, config, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { options, openedHere } = await openPicker(page, config, timeoutMs);
  const requested = options.find((option) => option.id === requestedId);
  if (!requested || !requested.available) {
    if (openedHere) await dismiss(page);
    throw error("model_unavailable", `${config.displayName} does not currently offer the requested model. No prompt was submitted.`);
  }
  try {
    const controls = page.locator(config.optionSelector).filter({ visible: true });
    await controls.nth(requested.index).click({ timeout: timeoutMs });
  } catch (cause) {
    if (openedHere) await dismiss(page);
    throw error("model_selection_unconfirmed", `${config.displayName}'s requested model could not be selected. No prompt was submitted.`, cause);
  }
  if (openedHere) await dismiss(page);
  await assertModelOptionSelected(page, requested, config, { timeoutMs, code: "model_selection_unconfirmed" });
  return {
    requested: requestedId,
    selected: { id: requested.id, label: requested.label },
    source: "ui_selection",
  };
}

export async function assertModelOptionSelected(page, expected, config, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  code = "model_selection_changed",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let mismatchSince = 0;
  while (Date.now() < deadline) {
    const selected = await currentSelection(page, config, Math.min(1_000, Math.max(100, deadline - Date.now())));
    if (selected?.id === expected.id) return selected;
    if (selected?.id && selected.id !== expected.id) {
      if (!mismatchSince) mismatchSince = Date.now();
      if (Date.now() - mismatchSince >= 250) break;
    } else {
      mismatchSince = 0;
    }
    await page.waitForTimeout(100);
  }
  throw error(code, `${config.displayName}'s selected model changed or could not be confirmed. No prompt was submitted.`);
}

export class SubmissionGate {
  #tail = Promise.resolve();

  async run(task) {
    const prior = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await prior.catch(() => {});
    try {
      return await task();
    } finally {
      release();
    }
  }
}
