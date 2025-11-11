(function () {
  const e = React.createElement;
  const cryptoUtils = window.ChatLockCrypto || {};
  const { encryptText, decryptText, hashPin } = cryptoUtils;

  if (!encryptText || !decryptText || !hashPin) {
    console.warn("ChatGPT lock: crypto helpers missing.");
    return;
  }

  const LOCK_ROOT_ID = "chatgpt-lock-button-root";
  const LOCK_CONTROLS_CLASS = "chatgpt-lock-controls-row";
  const OVERLAY_ROOT_ID = "chatgpt-lock-overlay-root";
  const FOLDER_ENTRY_ID = "chatgpt-lock-folder-entry";
  const RESTORE_QUEUE_KEY = "chatgpt-lock:pending-restores";
  const LOCK_STATE_EVENT = "chatgpt-lock:state";
  const LOCK_PATH =
    "M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zm-5 7.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zM10 9V7a2 2 0 0 1 4 0v2z";

  const storage = {
    get(keys) {
      return new Promise((resolve) => {
        chrome.storage.local.get(keys, (items) => resolve(items));
      });
    },
    set(items) {
      return new Promise((resolve) => {
        chrome.storage.local.set(items, () => resolve());
      });
    },
  };

  const lockState = {
    lockedChats: {},
    unlockedLockKeys: new Set(),
    routeToken: getRouteToken(),
    lastLockKey: getLockKeyFromUrl(),
  };

  let overlayMount = null;
  let overlayRoot = null;
  let overlayHost = null;
  let overlayState = null;

  function getConversationId(urlString = window.location.href) {
    try {
      const url = new URL(urlString);
      const parts = url.pathname.split("/").filter(Boolean);
      const idx = parts.indexOf("c");
      if (idx !== -1 && parts[idx + 1]) {
        return parts[idx + 1];
      }
      const queryId =
        url.searchParams.get("conversation_id") ||
        url.searchParams.get("conversationId") ||
        url.searchParams.get("conversation");
      return queryId || null;
    } catch {
      return null;
    }
  }

  function getProjectId(urlString = window.location.href) {
    try {
      const url = new URL(urlString);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && parts[parts.length - 1] === "project") {
        return parts[parts.length - 2];
      }
      return (
        url.searchParams.get("project_id") ||
        url.searchParams.get("projectId") ||
        null
      );
    } catch {
      return null;
    }
  }

  function getLockKeyFromUrl(href = window.location.href) {
    const conversationId = getConversationId(href);
    if (conversationId) return conversationId;
    const projectId = getProjectId(href);
    return projectId ? `project:${projectId}` : null;
  }

  function getRouteToken() {
    try {
      const url = new URL(window.location.href);
      return `${url.pathname}${url.search}::${
        getConversationId(url.href) || "root"
      }`;
    } catch {
      return `${window.location.pathname}${window.location.search}::${
        getConversationId() || "root"
      }`;
    }
  }

  function getCurrentConversationId() {
    return getConversationId();
  }

  function loadRestoreQueue() {
    try {
      const raw = sessionStorage.getItem(RESTORE_QUEUE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveRestoreQueue(queue) {
    try {
      sessionStorage.setItem(RESTORE_QUEUE_KEY, JSON.stringify(queue));
    } catch {
      // ignore quota errors
    }
  }

  function queueRestorePayload(conversationId, payload) {
    if (!conversationId || !payload) return;
    const queue = loadRestoreQueue();
    queue[conversationId] = payload;
    saveRestoreQueue(queue);
  }

  function applyPendingRestoreForCurrentChat() {
    const conversationId = getCurrentConversationId();
    if (!conversationId) return;
    const queue = loadRestoreQueue();
    const payload = queue[conversationId];
    if (!payload) return;
    restoreMessagesFromPayload(payload);
    delete queue[conversationId];
    saveRestoreQueue(queue);
  }

  function getLockedEntry(lockKey) {
    if (!lockKey) return null;
    return lockState.lockedChats?.[lockKey] || null;
  }

  function getLockedEntryForRoute(href = window.location.href) {
    const map = lockState.lockedChats || {};
    const conversationId = getConversationId(href);
    if (conversationId && map[conversationId]) {
      return {
        entry: map[conversationId],
        conversationId,
        lockKey: conversationId,
      };
    }
    const projectId = getProjectId(href);
    const projectKey = projectId ? `project:${projectId}` : null;
    if (projectKey && map[projectKey]) {
      return {
        entry: map[projectKey],
        projectId,
        lockKey: projectKey,
      };
    }
    let url;
    try {
      url = new URL(href);
    } catch {
      return { entry: null, lockKey: null };
    }
    for (const [key, meta] of Object.entries(map)) {
      if (
        meta &&
        (!meta.targetPath || meta.targetPath === url.pathname) &&
        (!meta.targetSearch || meta.targetSearch === url.search)
      ) {
        return {
          entry: meta,
          lockKey: key,
          conversationId: meta.conversationId || null,
          projectId: meta.projectId || null,
        };
      }
    }
    return { entry: null, lockKey: null };
  }

  function getActiveLockContext() {
    const { entry, lockKey, conversationId, projectId } =
      getLockedEntryForRoute();
    if (!entry) return null;
    if (lockKey && lockState.unlockedLockKeys.has(lockKey)) {
      return null;
    }
    return { entry, lockKey, conversationId, projectId };
  }

  function collectConversation() {
    const nodes = document.querySelectorAll("[data-message-author-role]");
    const messages = [];
    let fallbackIndex = 0;
    nodes.forEach((node) => {
      const role = node.getAttribute("data-message-author-role");
      if (!role || (role !== "user" && role !== "assistant")) {
        return;
      }
      let messageId =
        node.getAttribute("data-message-id") ||
        node.dataset.chatgptLockMessageId ||
        node.id;
      if (!messageId) {
        fallbackIndex += 1;
        messageId = `chatlock-${fallbackIndex}`;
      }
      node.dataset.chatgptLockMessageId = messageId;
      const content = (node.textContent || "").trim();
      const html = node.innerHTML;
      messages.push({ messageId, role, content, html, element: node });
    });
    return messages;
  }

  function clearComposerInput() {
    const textarea = document.querySelector("textarea");
    if (textarea) {
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function setMessageLocked(node, role) {
    if (!node || node.dataset.chatgptLock === "locked") {
      return;
    }
    node.dataset.chatgptLock = "locked";
    node.innerHTML = "";
    const wrapper = document.createElement("div");
    wrapper.className = "chatgpt-locked-message";
    wrapper.textContent =
      role === "user"
        ? "Prompt locked. Enter your PIN later to restore."
        : "Assistant message locked.";
    node.appendChild(wrapper);
  }

  function renderUnlockedMessage(node, saved) {
    node.dataset.chatgptLock = "unlocked";
    node.classList.remove("chatgpt-lock-restored");
    const html = (saved?.html || "").trim();
    if (html) {
      node.innerHTML = html;
      return;
    }
    node.classList.add("chatgpt-lock-restored");
    node.innerHTML = "";
    const content = (saved?.content || "").trim();
    if (!content) {
      node.textContent = "";
      return;
    }
    const blocks = content.split(/\n{2,}/).filter(Boolean);
    blocks.forEach((block) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = block;
      node.appendChild(paragraph);
    });
  }

  function maskConversationIfNeeded() {
    const context = getActiveLockContext();
    if (!context || (context.entry && context.entry.type === "project")) {
      return;
    }
    const messages = collectConversation();
    messages.forEach(({ element, role }) => setMessageLocked(element, role));
  }

  function restoreMessagesFromPayload(payload) {
    if (!payload || !payload.messages) return;
    const nodes = document.querySelectorAll("[data-message-author-role]");
    const messageMap = new Map();
    payload.messages.forEach((msg) => {
      if (msg.messageId) {
        messageMap.set(msg.messageId, msg);
      }
    });
    let sequentialIndex = 0;
    nodes.forEach((node) => {
      const role = node.getAttribute("data-message-author-role");
      if (role !== "user" && role !== "assistant") {
        return;
      }
      const domMessageId =
        node.getAttribute("data-message-id") ||
        node.dataset.chatgptLockMessageId ||
        node.id;
      if (domMessageId) {
        node.dataset.chatgptLockMessageId = domMessageId;
      }
      let saved = domMessageId ? messageMap.get(domMessageId) : null;
      if (!saved) {
        while (sequentialIndex < payload.messages.length) {
          const candidate = payload.messages[sequentialIndex];
          sequentialIndex += 1;
          if (candidate.role === role) {
            saved = candidate;
            break;
          }
        }
      }
      if (!saved || saved.role !== role) {
        return;
      }
      renderUnlockedMessage(node, saved);
    });
  }

  async function lockActiveConversation(pinKey) {
    const conversationId = getConversationId();
    const projectId = getProjectId();
    if (!conversationId && projectId) {
      return lockActiveProject(pinKey, projectId);
    }
    if (!conversationId) {
      throw new Error("Open an existing chat before locking.");
    }
    const messages = collectConversation();
    if (!messages.length) {
      throw new Error("Send a message before locking.");
    }
    const payload = {
      lockedAt: new Date().toISOString(),
      location: window.location.href,
      conversationId,
      messages: messages.map(({ messageId, role, content, html }) => ({
        messageId,
        role,
        content,
        html,
      })),
    };
    const { ciphertext, iv } = await encryptText(
      pinKey,
      JSON.stringify(payload)
    );
    messages.forEach(({ element, role }) => setMessageLocked(element, role));
    clearComposerInput();
    let targetPath = window.location.pathname;
    let targetSearch = window.location.search;
    try {
      const currentUrl = new URL(window.location.href);
      targetPath = currentUrl.pathname;
      targetSearch = currentUrl.search;
    } catch {
      // ignore, fallback to window values
    }
    const resolvedTitle =
      resolveConversationTitle(conversationId, getActiveConversationTitle()) ||
      "Private chat";
    const lockKey = conversationId;
    const lockedMeta = {
      type: "chat",
      lockKey,
      ciphertext,
      iv,
      lockedAt: Date.now(),
      title: resolvedTitle,
      originalTitle: resolvedTitle,
      conversationId,
      targetPath,
      targetSearch,
      location: window.location.href,
    };
    const nextLockedChats = { ...(lockState.lockedChats || {}) };
    nextLockedChats[lockKey] = lockedMeta;
    await storage.set({ lockedChats: nextLockedChats });
    lockState.lockedChats = nextLockedChats;
    lockState.unlockedLockKeys.delete(lockKey);
    emitLockStateChange();
    maskConversationIfNeeded();
    evaluateOverlay();
    updateSidebarTitle();
    return { ciphertext, iv };
  }

  async function lockActiveProject(pinKey, projectId) {
    const payload = {
      lockedAt: new Date().toISOString(),
      location: window.location.href,
      projectId,
    };
    const { ciphertext, iv } = await encryptText(
      pinKey,
      JSON.stringify(payload)
    );
    let targetPath = window.location.pathname;
    let targetSearch = window.location.search;
    try {
      const currentUrl = new URL(window.location.href);
      targetPath = currentUrl.pathname;
      targetSearch = currentUrl.search;
    } catch {
      // fallback
    }
    const lockKey = `project:${projectId}`;
    const lockedMeta = {
      type: "project",
      lockKey,
      projectId,
      projectTitle: "Private project",
      ciphertext,
      iv,
      lockedAt: Date.now(),
      targetPath,
      targetSearch,
      location: window.location.href,
    };
    const nextLockedChats = { ...(lockState.lockedChats || {}) };
    nextLockedChats[lockKey] = lockedMeta;
    await storage.set({ lockedChats: nextLockedChats });
    lockState.lockedChats = nextLockedChats;
    lockState.unlockedLockKeys.delete(lockKey);
    emitLockStateChange();
    evaluateOverlay();
    return { ciphertext, iv };
  }

  let toastTimeout;
  function showToast(message, tone = "info") {
    if (!document.body) return;
    let toast = document.querySelector(".chatgpt-lock-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "chatgpt-lock-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle("chatgpt-lock-toast--error", tone === "error");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast?.remove();
    }, 4200);
  }

  function openOptionsPage() {
    chrome.runtime.sendMessage({ type: "chatgpt-lock:open-options" });
  }

  function showPinToast() {
    if (!document.body) return;
    let toast = document.querySelector(".chatgpt-lock-pin-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className =
        "chatgpt-lock-toast chatgpt-lock-pin-toast chatgpt-lock-toast--error";
      const text = document.createElement("span");
      text.className = "chatgpt-lock-pin-toast__text";
      text.textContent = "Set a PIN to use Private Chats.";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "chatgpt-lock-toast__link";
      link.textContent = "Open settings";
      link.addEventListener("click", (event) => {
        event.stopPropagation();
        openOptionsPage();
      });
      toast.append(text, link);
      document.body.appendChild(toast);
    }
    toast.style.display = "flex";
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast?.remove();
    }, 5000);
  }

  function createLockSvg(className) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "currentColor");
    if (className) svg.setAttribute("class", className);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", LOCK_PATH);
    svg.appendChild(path);
    return svg;
  }

  function updateSidebarTitle() {
    const nav = document.querySelector("nav");
    if (!nav) return false;
    const entries = nav.querySelectorAll("a, button");
    let updated = false;
    const LOCK_LABEL_ATTR = "data-chatgpt-lock-title";
    const ORIGINAL_ATTR = "data-chatgpt-lock-original";
    entries.forEach((entry) => {
      const labelHost = getSidebarLabelHost(entry);
      if (!labelHost) return;
      const conversationId = extractConversationId(entry);
      const lockedMeta =
        conversationId && lockState.lockedChats
          ? lockState.lockedChats[conversationId]
          : null;
      if (lockedMeta) {
        labelHost.classList.add("chatgpt-lock-nav-label");
        labelHost.setAttribute(LOCK_LABEL_ATTR, "Private chat");
        if (!labelHost.querySelector(".chatgpt-lock-nav-icon")) {
          labelHost.appendChild(createLockSvg("chatgpt-lock-nav-icon"));
        }
        updated = true;
      } else {
        labelHost.classList.remove("chatgpt-lock-nav-label");
        labelHost.removeAttribute(LOCK_LABEL_ATTR);
        labelHost
          .querySelectorAll(".chatgpt-lock-nav-icon")
          .forEach((node) => node.remove());
      }
    });
    return updated;
  }

  function extractConversationId(entry) {
    const href =
      entry.getAttribute("href") ||
      entry.dataset.href ||
      entry.dataset.link ||
      "";
    if (href) {
      const id = getConversationId(href);
      if (id) return id;
      const match = href.match(/\/c\/([^/?#]+)/);
      if (match) return match[1];
    }
    return (
      entry.getAttribute("data-conversation-id") ||
      entry.dataset.conversationId ||
      null
    );
  }

  function getSidebarLabelHost(entry) {
    return (
      entry.querySelector('[data-testid="conversation-title"]') ||
      entry.querySelector('[data-testid="conversation-name"]') ||
      entry.querySelector(".truncate") ||
      entry.querySelector("span") ||
      entry.querySelector("div") ||
      entry
    );
  }

  function getActiveConversationTitle() {
    const nav = document.querySelector("nav");
    if (!nav) return null;
    const activeItem =
      nav.querySelector('a[aria-current="page"]') ||
      nav.querySelector("button[aria-current='page']") ||
      nav.querySelector('[data-active="true"]');
    if (!activeItem) return null;
    const labelHost = getSidebarLabelHost(activeItem);
    if (!labelHost) return null;
    const text = labelHost.textContent?.trim();
    return text || null;
  }

  function getProjectTitle() {
    const heading =
      document.querySelector("main h1") ||
      document.querySelector("header h1") ||
      document.querySelector('[data-testid="project-title"]');
    const text = heading?.textContent?.trim();
    if (text) return text;
    const title = document.title?.trim();
    return title || "Private project";
  }

  function resolveConversationTitle(conversationId, fallback) {
    if (!conversationId) return fallback || "Private chat";
    const nav = document.querySelector("nav");
    if (nav) {
      const entries = Array.from(nav.querySelectorAll("a, button"));
      for (const entry of entries) {
        const id = extractConversationId(entry);
        if (id === conversationId) {
          const labelHost = getSidebarLabelHost(entry);
          if (labelHost) {
            const original = labelHost.getAttribute(
              "data-chatgpt-lock-original"
            );
            if (original) return original;
            const text = labelHost.textContent?.trim();
            if (text) return text;
          }
        }
      }
    }
    return fallback || "Private chat";
  }

  function ensurePrivateFolderEntry() {
    const nav = document.querySelector("nav");
    if (!nav) return false;
    if (document.getElementById(FOLDER_ENTRY_ID)) return true;
    const libraryItem = Array.from(nav.querySelectorAll("a, button")).find(
      (node) => /library/i.test(node.textContent || "")
    );
    const entry = document.createElement("button");
    entry.id = FOLDER_ENTRY_ID;
    entry.type = "button";
    entry.className = "chatgpt-lock-folder-entry";
    entry.innerHTML = `
      <span class="chatgpt-lock-folder-entry__icon">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="${LOCK_PATH}" />
        </svg>
      </span>
      <span>Private chats</span>
    `;
    entry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPrivateFolderOverlay().catch((error) =>
        console.error("ChatGPT lock: folder overlay failed", error)
      );
    });
    const insertTarget =
      libraryItem && libraryItem.parentElement
        ? libraryItem.parentElement.tagName === "LI"
          ? libraryItem.parentElement
          : libraryItem
        : null;
    if (insertTarget && insertTarget.parentElement) {
      insertTarget.parentElement.insertBefore(entry, insertTarget);
    } else {
      nav.appendChild(entry);
    }
    return true;
  }

  async function openPrivateFolderOverlay() {
    const { pinKey } = await storage.get(["pinKey"]);
    if (!pinKey) {
      showPinToast();
      return;
    }
    renderOverlayComponent({
      mode: "folder",
      view: "pin",
      heading: "Private chats",
      actionLabel: "Unlock folder",
    });
  }

  function findShareButton() {
    const header = document.querySelector("header");
    if (!header) return null;
    const candidates = Array.from(header.querySelectorAll("button, a"));
    return (
      candidates.find((el) => {
        const testId = el.getAttribute("data-testid") || "";
        const label = (el.textContent || "").trim().toLowerCase();
        return (
          testId.includes("share") ||
          label === "share" ||
          label.includes("share link")
        );
      }) || null
    );
  }

  function LockIcon(props = {}) {
    const className = ["chatgpt-lock-icon", props.className]
      .filter(Boolean)
      .join(" ");
    return e(
      "svg",
      {
        className,
        viewBox: "0 0 24 24",
        role: "img",
        "aria-hidden": "true",
      },
      e("path", { d: LOCK_PATH, fill: "currentColor" })
    );
  }

  const LockButton = () => {
    const [state, setState] = React.useState("idle");
    const [locked, setLocked] = React.useState(false);

    const refreshButtonLockState = React.useCallback(() => {
      const conversationId = getCurrentConversationId();
      const projectId = getProjectId();
      const lockKey =
        conversationId || (projectId ? `project:${projectId}` : null);
      setLocked(Boolean(lockKey && getLockedEntry(lockKey)));
    }, []);

    React.useEffect(() => {
      refreshButtonLockState();
      const handler = () => refreshButtonLockState();
      window.addEventListener(LOCK_STATE_EVENT, handler);
      return () => window.removeEventListener(LOCK_STATE_EVENT, handler);
    }, [refreshButtonLockState]);

    const handleClick = async () => {
      if (state === "busy") return;
      setState("busy");
      try {
        const { pinKey } = await storage.get(["pinKey"]);
        if (!pinKey) {
          showPinToast();
          return;
        }
        await lockActiveConversation(pinKey);
        setLocked(true);
        const activeProject = !getCurrentConversationId() && getProjectId();
        showToast(activeProject ? "Project locked." : "Chat locked.");
      } catch (error) {
        console.error("Lock failed", error);
        showToast(error?.message || "Failed to lock chat.", "error");
      } finally {
        setState("idle");
      }
    };

    return e(
      "button",
      {
        className: "chatgpt-lock-button",
        disabled: state === "busy",
        onClick: handleClick,
      },
      e(LockIcon, null),
      e("span", null, locked ? "Locked" : "Lock")
    );
  };

  function ensureControlsWrapper(shareButton) {
    if (!shareButton) return null;
    const selector = `.${LOCK_CONTROLS_CLASS}`;
    const existingWrapper = shareButton.closest(selector);
    if (existingWrapper) {
      return existingWrapper;
    }
    const wrapperInDom = document.querySelector(selector);
    if (wrapperInDom) {
      if (shareButton.parentElement !== wrapperInDom) {
        wrapperInDom.appendChild(shareButton);
      }
      return wrapperInDom;
    }
    const parent = shareButton.parentElement;
    if (!parent) return null;
    const wrapper = document.createElement("div");
    wrapper.className = LOCK_CONTROLS_CLASS;
    parent.insertBefore(wrapper, shareButton);
    wrapper.appendChild(shareButton);
    return wrapper;
  }

  function ensureLockButton() {
    const shareButton = findShareButton();
    if (!shareButton) return false;
    const container = ensureControlsWrapper(shareButton);
    if (!container) return false;
    container.classList.add(LOCK_CONTROLS_CLASS);
    if (!document.getElementById(LOCK_ROOT_ID)) {
      const mountNode = document.createElement("div");
      mountNode.id = LOCK_ROOT_ID;
      container.insertBefore(mountNode, shareButton);
      const reactRoot = ReactDOM.createRoot(mountNode);
      reactRoot.render(e(LockButton));
    }
    return true;
  }

  function ensureLockButtonWithRetry() {
    if (!ensureLockButton()) {
      setTimeout(ensureLockButtonWithRetry, 800);
    }
  }

  const LockOverlay = (props) => {
    const { state } = props;
    if (!state) return null;
    if (state.mode === "folder") {
      return e(PrivateFolderOverlay, props);
    }
    const meta = state.meta || {};
    const isProject = meta.type === "project";
    const headingTitle = isProject
      ? "This project is locked"
      : "Unlock this chat";
    const copyText = isProject
      ? "Enter your PIN to unlock this project."
      : "Enter your PIN to decrypt this chat.";
    const buttonLabel = isProject ? "Unlock project" : "Unlock chat";
    const [pin, setPin] = React.useState("");
    const [status, setStatus] = React.useState("idle");
    const [error, setError] = React.useState("");

    const handleSubmit = async (event) => {
      event.preventDefault();
      setError("");
      try {
        setStatus("busy");
        await props.submitPin(pin);
        setPin("");
      } catch (err) {
        setError(err?.message || "Failed to unlock.");
      } finally {
        setStatus("idle");
      }
    };

    return e(
      "div",
      { className: "chatgpt-lock-overlay" },
      e(
        "form",
        { className: "chatgpt-lock-overlay__panel", onSubmit: handleSubmit },
        e(LockIcon, { className: "chatgpt-lock-overlay__icon" }),
        e("h2", { className: "chatgpt-lock-overlay__heading" }, headingTitle),
        e("p", { className: "chatgpt-lock-overlay__copy" }, copyText),
        e(
          "label",
          {
            className: "chatgpt-lock-overlay__label",
            htmlFor: "chatgpt-lock-pin",
          },
          "PIN"
        ),
        e("input", {
          id: "chatgpt-lock-pin",
          className: "chatgpt-lock-overlay__input",
          type: "password",
          inputMode: "numeric",
          autoComplete: "off",
          value: pin,
          onChange: (event) => setPin(event.target.value),
        }),
        error
          ? e("p", { className: "chatgpt-lock-overlay__error" }, error)
          : null,
        e(
          "button",
          {
            type: "submit",
            className: "chatgpt-lock-overlay__primary",
            disabled: status === "busy",
          },
          status === "busy" ? "Unlocking..." : buttonLabel
        )
      )
    );
  };

  const PrivateFolderOverlay = ({
    closeOverlay,
    requestFolderPin,
    unlockChatFromFolder,
    getLockedChatsSnapshot,
    state,
  }) => {
    const [pin, setPin] = React.useState("");
    const [status, setStatus] = React.useState("idle");
    const [error, setError] = React.useState("");
    const [pinKey, setPinKey] = React.useState(null);
    const [view, setView] = React.useState("pin");
    const [lockedChats, setLockedChats] = React.useState(
      () => getLockedChatsSnapshot() || {}
    );

    React.useEffect(() => {
      if (view === "list") {
        setLockedChats(getLockedChatsSnapshot() || {});
      }
    }, [view, getLockedChatsSnapshot]);

    const handlePinSubmit = async (event) => {
      event.preventDefault();
      setError("");
      try {
        setStatus("busy");
        const verified = await requestFolderPin(pin);
        setPinKey(verified);
        setPin("");
        setView("list");
        setError("");
      } catch (err) {
        setError(err?.message || "Failed to unlock folder.");
      } finally {
        setStatus("idle");
      }
    };

    const handleUnlockChat = async (conversationId) => {
      if (!pinKey) {
        setError("Unlock the folder first.");
        setView("pin");
        return;
      }
      try {
        setStatus("busy");
        await unlockChatFromFolder(conversationId, pinKey);
        closeOverlay();
      } catch (err) {
        setError(err?.message || "Unable to open chat.");
      } finally {
        setStatus("idle");
      }
    };

    const renderList = () => {
      const entries = Object.entries(lockedChats || {});
      return e(
        "div",
        { className: "chatgpt-lock-overlay" },
        e(
          "div",
          { className: "chatgpt-lock-overlay__panel chatgpt-lock-folder" },
          e(
            "div",
            { className: "chatgpt-lock-folder__header" },
            e("div", { className: "chatgpt-lock-folder__title" }, [
              e(LockIcon, { className: "chatgpt-lock-overlay__icon" }),
              e(
                "h2",
                { className: "chatgpt-lock-overlay__heading" },
                "Private chats"
              ),
            ]),
            e(
              "button",
              {
                type: "button",
                className: "chatgpt-lock-folder__close",
                onClick: () => closeOverlay(true),
              },
              "Close"
            )
          ),
          entries.length === 0
            ? e(
                "p",
                { className: "chatgpt-lock-overlay__copy" },
                "No locked chats available."
              )
            : e(
                "ul",
                { className: "chatgpt-lock-folder__list" },
                entries.map(([conversationId, meta]) => {
                  const displayTitle =
                    meta?.originalTitle ||
                    resolveConversationTitle(
                      conversationId,
                      meta?.title || "Private chat"
                    );
                  return e(
                    "li",
                    { key: conversationId },
                    e(
                      "button",
                      {
                        type: "button",
                        className: "chatgpt-lock-folder__item",
                        disabled: status === "busy",
                        onClick: () => handleUnlockChat(conversationId),
                      },
                      e("span", null, displayTitle)
                    )
                  );
                })
              )
        )
      );
    };

    return view === "list"
      ? renderList()
      : e(
          "div",
          { className: "chatgpt-lock-overlay" },
          e(
            "form",
            {
              className: "chatgpt-lock-overlay__panel",
              onSubmit: handlePinSubmit,
            },
            e(LockIcon, { className: "chatgpt-lock-overlay__icon" }),
            e(
              "h2",
              { className: "chatgpt-lock-overlay__heading" },
              "Private chats folder"
            ),
            e(
              "p",
              { className: "chatgpt-lock-overlay__copy" },
              "Enter your PIN to view your folder."
            ),
            e(
              "label",
              {
                className: "chatgpt-lock-overlay__label",
                htmlFor: "chatgpt-lock-folder-pin",
              },
              "PIN"
            ),
            e("input", {
              id: "chatgpt-lock-folder-pin",
              className: "chatgpt-lock-overlay__input",
              type: "password",
              inputMode: "numeric",
              autoComplete: "off",
              value: pin,
              onChange: (event) => setPin(event.target.value),
            }),
            error
              ? e("p", { className: "chatgpt-lock-overlay__error" }, error)
              : null,
            e(
              "div",
              { className: "chatgpt-lock-folder__actions" },
              e(
                "button",
                {
                  type: "button",
                  className: "chatgpt-lock-folder__close",
                  onClick: () => closeOverlay(true),
                },
                "Cancel"
              ),
              e(
                "button",
                {
                  type: "submit",
                  className: "chatgpt-lock-overlay__primary",
                  disabled: status === "busy",
                },
                status === "busy" ? "Unlocking..." : "Unlock folder"
              )
            )
          )
        );
  };

  function getChatContainer() {
    return (
      document.querySelector("main") ||
      document.querySelector('[data-testid="conversation-panel"]') ||
      document.querySelector('[data-testid="conversation-turns"]')
    );
  }

  function ensureOverlayRoot() {
    const container = getChatContainer();
    if (!container) {
      return null;
    }
    if (overlayMount && overlayHost === container) {
      return container;
    }
    if (overlayMount && overlayHost && overlayMount.parentElement) {
      overlayHost.classList.remove("chatgpt-lock-overlay-host");
      overlayMount.parentElement.removeChild(overlayMount);
    }
    overlayHost = container;
    overlayHost.classList.add("chatgpt-lock-overlay-host");
    overlayMount = document.createElement("div");
    overlayMount.id = OVERLAY_ROOT_ID;
    overlayHost.appendChild(overlayMount);
    overlayRoot = ReactDOM.createRoot(overlayMount);
    return container;
  }

  function renderOverlayComponent(state) {
    overlayState = state;
    const container = ensureOverlayRoot();
    if (!container || !overlayRoot) return;
    overlayRoot.render(
      e(LockOverlay, {
        state,
        submitPin: attemptUnlockWithPin,
        closeOverlay,
        requestFolderPin: verifyPinInput,
        unlockChatFromFolder,
        getLockedChatsSnapshot: () => {
          const snapshot = {};
          Object.entries(lockState.lockedChats || {}).forEach(([key, meta]) => {
            if (meta?.type && meta.type !== "chat") return;
            if (meta?.conversationId) {
              snapshot[meta.conversationId] = meta;
            }
          });
          return snapshot;
        },
      })
    );
  }

  function closeOverlay(recheck = false) {
    overlayState = null;
    if (overlayRoot) {
      overlayRoot.render(null);
    }
    if (recheck) {
      evaluateOverlay();
    }
  }

  function handleGlobalNavigationClick(event) {
    if (!overlayState || overlayState.mode !== "folder") return;
    const target = event.target;
    if (!target) return;
    const navInteractive = target.closest("nav a, nav button");
    if (navInteractive && navInteractive.id !== FOLDER_ENTRY_ID) {
      closeOverlay();
    }
  }

  async function verifyPinInput(pin) {
    const trimmed = (pin || "").trim();
    if (!trimmed) {
      throw new Error("Enter your PIN.");
    }
    const { pinKey } = await storage.get(["pinKey"]);
    if (!pinKey) {
      showPinToast();
      throw new Error("Set a PIN in the extension options first.");
    }
    const hashed = await hashPin(trimmed);
    if (hashed !== pinKey) {
      throw new Error("Incorrect PIN.");
    }
    return pinKey;
  }

  async function attemptUnlockWithPin(pin) {
    const {
      entry: lockedEntry,
      lockKey,
      conversationId,
    } = getLockedEntryForRoute();
    if (!lockedEntry) {
      throw new Error("This item is not locked.");
    }
    const [{ lockedChats }] = await Promise.all([storage.get(["lockedChats"])]);
    const pinKey = await verifyPinInput(pin);
    const lockerMap = lockedChats || lockState.lockedChats || {};
    lockState.lockedChats = lockerMap;
    const plaintext = await decryptText(
      pinKey,
      lockedEntry.ciphertext,
      lockedEntry.iv
    );
    const payload = JSON.parse(plaintext);
    if (lockKey) {
      lockState.unlockedLockKeys.add(lockKey);
      delete lockerMap[lockKey];
    }
    lockState.lockedChats = lockerMap;
    await storage.set({ lockedChats: lockerMap });
    emitLockStateChange();
    closeOverlay(true);
    if (lockedEntry.type === "project") {
      showToast("Project unlocked.");
    } else {
      if (payload) {
        restoreMessagesFromPayload(payload);
      }
      showToast("Chat decrypted.");
    }
    return payload;
  }

  async function unlockChatFromFolder(conversationId, pinKey) {
    if (!conversationId || !pinKey) {
      throw new Error("Missing chat or PIN context.");
    }
    const entry = lockState.lockedChats?.[conversationId];
    if (!entry) {
      throw new Error("Chat already unlocked.");
    }
    if (entry.type && entry.type !== "chat") {
      throw new Error("This item is not a chat.");
    }
    const plaintext = await decryptText(pinKey, entry.ciphertext, entry.iv);
    const payload = JSON.parse(plaintext);
    queueRestorePayload(conversationId, payload);
    const updated = { ...lockState.lockedChats };
    delete updated[conversationId];
    lockState.lockedChats = updated;
    lockState.unlockedLockKeys.add(conversationId);
    await storage.set({ lockedChats: updated });
    emitLockStateChange();
    const targetUrl = entry.location || `/c/${conversationId}`;
    window.location.assign(targetUrl);
  }

  function evaluateOverlay() {
    if (overlayState?.mode === "folder") {
      renderOverlayComponent(overlayState);
      return;
    }
    const context = getActiveLockContext();
    const shouldShow = Boolean(context);
    const container = getChatContainer();
    if (!container) {
      if (overlayHost) {
        overlayHost.classList.remove("chatgpt-lock-overlay-host");
        overlayHost.classList.remove("chatgpt-lock-obscured");
      }
      overlayHost = null;
      closeOverlay();
      return;
    }
    container.classList.toggle("chatgpt-lock-obscured", shouldShow);
    if (shouldShow) {
      renderOverlayComponent({ mode: "gate", meta: context.entry });
    } else {
      closeOverlay();
    }
  }

  function observeMutations() {
    const observer = new MutationObserver(() => {
      ensureLockButton();
      ensurePrivateFolderEntry();
      applyPendingRestoreForCurrentChat();
      maskConversationIfNeeded();
      updateSidebarTitle();
      evaluateOverlay();
    });
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
  }

  function observeRouteChanges() {
    setInterval(() => {
      const token = getRouteToken();
      if (token !== lockState.routeToken) {
        const previousKey = lockState.lastLockKey;
        lockState.routeToken = token;
        const currentKey = getLockKeyFromUrl();
        lockState.lastLockKey = currentKey;
        if (previousKey && previousKey !== currentKey) {
          lockState.unlockedLockKeys.delete(previousKey);
        }
        if (currentKey) {
          lockState.unlockedLockKeys.delete(currentKey);
        }
        if (overlayState?.mode === "folder") {
          closeOverlay();
        }
        emitLockStateChange();
        maskConversationIfNeeded();
        evaluateOverlay();
        updateSidebarTitle();
      }
    }, 750);
  }

  async function bootstrap() {
    const { lockedChats, lockedChat } = await storage.get([
      "lockedChats",
      "lockedChat",
    ]);
    let resolvedChats = lockedChats || {};
    if (!lockedChats && lockedChat?.conversationId) {
      resolvedChats = { [lockedChat.conversationId]: lockedChat };
      await storage.set({ lockedChats: resolvedChats });
    }
    lockState.lockedChats = resolvedChats;
    lockState.unlockedLockKeys.clear();
    lockState.lastLockKey = getLockKeyFromUrl();
    emitLockStateChange();
    ensureLockButtonWithRetry();
    ensurePrivateFolderEntry();
    applyPendingRestoreForCurrentChat();
    maskConversationIfNeeded();
    evaluateOverlay();
    updateSidebarTitle();
    observeMutations();
    observeRouteChanges();
    chrome.storage.onChanged.addListener(handleStorageChange);
    document.addEventListener("click", handleGlobalNavigationClick, true);
  }

  function handleStorageChange(changes, area) {
    if (area === "local" && changes.lockedChats) {
      lockState.lockedChats = changes.lockedChats.newValue || {};
      lockState.unlockedLockKeys.clear();
      emitLockStateChange();
      maskConversationIfNeeded();
      evaluateOverlay();
      updateSidebarTitle();
    }
  }

  function emitLockStateChange() {
    window.dispatchEvent(
      new CustomEvent(LOCK_STATE_EVENT, {
        detail: {
          lockedChats: lockState.lockedChats,
          unlockedLockKeys: Array.from(lockState.unlockedLockKeys),
        },
      })
    );
    if (overlayState?.mode === "folder") {
      renderOverlayComponent({
        ...overlayState,
        mode: "folder",
        view: overlayState.view || "list",
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
