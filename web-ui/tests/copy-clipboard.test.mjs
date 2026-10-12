import { test } from "node:test";
import assert from "node:assert/strict";
import { copyToClipboard } from "../src/util.ts";

test("copyToClipboard uses navigator.clipboard in secure contexts", async () => {
  let written = "";
  const origNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          async writeText(str) {
            written = str;
          },
        },
      },
      configurable: true,
    });

    const ok = await copyToClipboard("test-secure-text");
    assert.equal(ok, true);
    assert.equal(written, "test-secure-text");
  } finally {
    if (origNav) Object.defineProperty(globalThis, "navigator", origNav);
  }
});

test("copyToClipboard falls back to document.execCommand in non-secure HTTP LAN contexts", async () => {
  const origNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const origDoc = globalThis.document;

  let commandRun = "";
  let textareaAppended = null;
  let focused = false;
  let selected = false;
  let removed = false;

  const mockBody = {
    appendChild(el) {
      textareaAppended = el;
    },
    removeChild(el) {
      if (el === textareaAppended) {
        removed = true;
        el.parentNode = null;
      }
    },
  };

  try {
    // Simulate HTTP LAN origin: navigator.clipboard is undefined
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
    });

    globalThis.document = {
      body: mockBody,
      createElement(tag) {
        assert.equal(tag, "textarea");
        const el = {
          value: "",
          parentNode: mockBody,
          style: {},
          setAttribute() {},
          focus() {
            focused = true;
          },
          select() {
            selected = true;
          },
        };
        return el;
      },
      execCommand(cmd) {
        commandRun = cmd;
        return true;
      },
    };

    const ok = await copyToClipboard("lio-connect:v1:payload123");
    assert.equal(ok, true);
    assert.equal(commandRun, "copy");
    assert.equal(textareaAppended?.value, "lio-connect:v1:payload123");
    assert.equal(focused, true);
    assert.equal(selected, true);
    assert.equal(removed, true, "Temporary textarea must be removed in finally block");
  } finally {
    if (origNav) Object.defineProperty(globalThis, "navigator", origNav);
    globalThis.document = origDoc;
  }
});

test("copyToClipboard returns false when both APIs fail and still cleans up DOM", async () => {
  const origNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const origDoc = globalThis.document;
  let removed = false;

  const mockBody = {
    appendChild() {},
    removeChild() {
      removed = true;
    },
  };

  try {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
    });

    globalThis.document = {
      body: mockBody,
      createElement() {
        return {
          value: "",
          parentNode: mockBody,
          style: {},
          setAttribute() {},
          focus() {},
          select() {},
        };
      },
      execCommand() {
        return false; // Copy command denied
      },
    };

    const ok = await copyToClipboard("failed-text");
    assert.equal(ok, false);
    assert.equal(removed, true, "Textarea must be cleaned up even on failure");
  } finally {
    if (origNav) Object.defineProperty(globalThis, "navigator", origNav);
    globalThis.document = origDoc;
  }
});
