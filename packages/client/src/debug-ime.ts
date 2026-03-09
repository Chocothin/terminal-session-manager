// Debug script to log IME events - will be removed after debugging
export function setupIMEDebug(textarea: HTMLTextAreaElement, label: string) {
  const events = ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'keydown', 'beforeinput'];
  events.forEach(evt => {
    textarea.addEventListener(evt, (e: any) => {
      console.log(`[IME-DEBUG ${label}] ${evt}:`, {
        data: e.data,
        inputType: e.inputType,
        key: e.key,
        isComposing: e.isComposing,
        target: e.target?.value
      });
    }, true);
  });
}
