// The browser demo has no real passkey device prompt to show, so it asks through this small modal instead.
// Real deployments never use this: the operating system shows Touch ID, Windows Hello, Android or the security key.
export interface PromptRequest { id: number; title: string; who: string; detail: string; resolve: (ok: boolean) => void }
type Listener = (r: PromptRequest | null) => void;
let listener: Listener | null = null; let seq = 0;
export function onPrompt(l: Listener) { listener = l; return () => { if (listener === l) listener = null; }; }
export function askDevice(title: string, who: string, detail: string): Promise<boolean> {
  return new Promise(resolve => {
    if (!listener) { resolve(true); return; }
    const req: PromptRequest = { id: ++seq, title, who, detail, resolve: ok => { listener?.(null); resolve(ok); } };
    listener(req);
  });
}
