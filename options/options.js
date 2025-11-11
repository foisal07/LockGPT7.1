(function () {
  const { hashPin } = window.ChatLockCrypto;
  const e = React.createElement;
  const CHAT_URL = "https://chat.openai.com/";
  const CHAT_URL_MATCHERS = [
    "https://chat.openai.com/*",
    "https://chatgpt.com/*",
  ];

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

  const tabs = {
    create(props) {
      return new Promise((resolve, reject) => {
        chrome.tabs.create(props, (tab) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(err);
          } else {
            resolve(tab);
          }
        });
      });
    },
    query(queryInfo) {
      return new Promise((resolve, reject) => {
        chrome.tabs.query(queryInfo, (foundTabs) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(err);
          } else {
            resolve(foundTabs);
          }
        });
      });
    },
    update(tabId, updateProperties) {
      return new Promise((resolve, reject) => {
        chrome.tabs.update(tabId, updateProperties, (tab) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(err);
          } else {
            resolve(tab);
          }
        });
      });
    },
    reload(tabId, reloadProperties) {
      return new Promise((resolve, reject) => {
        chrome.tabs.reload(tabId, reloadProperties, () => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };

  const focusAndReloadChatTab = async () => {
    try {
      const chatTabs = await tabs.query({ url: CHAT_URL_MATCHERS });
      const targetTab = (chatTabs || []).reduce((latest, current) => {
        if (!current || typeof current.id === "undefined") {
          return latest;
        }
        if (!latest) {
          return current;
        }
        const latestAccess = latest.lastAccessed || 0;
        const currentAccess = current.lastAccessed || 0;
        return currentAccess > latestAccess ? current : latest;
      }, null);

      if (targetTab && typeof targetTab.id !== "undefined") {
        await tabs.update(targetTab.id, { active: true });
        await tabs.reload(targetTab.id);
        return;
      }

      const createdTab = await tabs.create({ url: CHAT_URL });
      if (createdTab && typeof createdTab.id !== "undefined") {
        await tabs.reload(createdTab.id);
      }
    } catch (error) {
      console.warn("Failed to focus or reload ChatGPT tab", error);
    }
  };

  const useChromeValue = (key) => {
    const [value, setValue] = React.useState(null);
    React.useEffect(() => {
      storage.get([key]).then((result) => {
        setValue(result[key] ?? null);
      });
    }, [key]);
    return [value, setValue];
  };

  const StatusText = ({ message, tone }) =>
    message
      ? e(
          "p",
          { className: tone === "error" ? "status error" : "status" },
          message
        )
      : null;

  const OptionsApp = () => {
    const [pin, setPin] = React.useState("");
    const [confirmPin, setConfirmPin] = React.useState("");
    const [status, setStatus] = React.useState("idle");
    const [message, setMessage] = React.useState("");
    const [tone, setTone] = React.useState("info");
    const [storedPinKey, setStoredPinKey] = useChromeValue("pinKey");
    const isOnboarding = window.location.hash.includes("onboarding");

    const handleSave = async (event) => {
      event.preventDefault();
      setMessage("");
      if (!pin || pin.length < 4) {
        setTone("error");
        setMessage("PIN should be at least 4 digits.");
        return;
      }
      if (pin !== confirmPin) {
        setTone("error");
        setMessage("Pins do not match.");
        return;
      }
      try {
        setStatus("saving");
        const hashedPin = await hashPin(pin);
        await storage.set({
          pinKey: hashedPin,
          pinUpdatedAt: Date.now(),
        });
        setStoredPinKey(hashedPin);
        setTone("info");
        setMessage("PIN saved successfully.");
        setPin("");
        setConfirmPin("");
        await focusAndReloadChatTab();
        if (isOnboarding) {
          window.close();
        }
      } catch (error) {
        console.error("Failed to save pin", error);
        setTone("error");
        setMessage("Something went wrong while saving the PIN.");
      } finally {
        setStatus("idle");
      }
    };

    return e(
      "main",
      { className: "card" },
      e("h1", null, "Secure Chat PIN"),
      e(
        "p",
        null,
        storedPinKey
          ? "Update your lock PIN anytime. This never leaves your device."
          : "Set a lock PIN to protect private ChatGPT conversations."
      ),
      e(
        "form",
        { onSubmit: handleSave },
        e(
          "div",
          { className: "field" },
          e("label", { htmlFor: "pin" }, "PIN"),
          e("input", {
            id: "pin",
            type: "password",
            inputMode: "numeric",
            autoComplete: "new-password",
            maxLength: 8,
            value: pin,
            onChange: (event) => setPin(event.target.value),
          })
        ),
        e(
          "div",
          { className: "field" },
          e("label", { htmlFor: "confirmPin" }, "Confirm PIN"),
          e("input", {
            id: "confirmPin",
            type: "password",
            inputMode: "numeric",
            autoComplete: "new-password",
            maxLength: 8,
            value: confirmPin,
            onChange: (event) => setConfirmPin(event.target.value),
          })
        ),
        e(
          "div",
          { className: "actions" },
          e(
            "button",
            {
              type: "submit",
              className: "primary",
              disabled: status === "saving",
            },
            status === "saving" ? "Saving..." : "Save PIN"
          )
        ),
        e(StatusText, { message, tone })
      )
    );
  };

  document.addEventListener("DOMContentLoaded", () => {
    const root = ReactDOM.createRoot(document.getElementById("options-root"));
    root.render(e(OptionsApp));
  });
})();
