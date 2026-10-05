'use client';
// Voice and text assistant. Every sentence shows numbered sources; clicking one opens the audit, finding, policy or schedule.
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../kit';
import type { Answer } from '../api';
import type { Citation } from '../../lib/core/assistant';

type Msg = { role: 'user'; text: string; via: 'voice' | 'text' } | { role: 'assistant'; answer: Answer } | { role: 'error'; text: string };
type Rec = { start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null; lang: string; interimResults: boolean };
const SpeechRec = (): (new () => Rec) | null => { const w = globalThis as unknown as Record<string, unknown>; return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => Rec) | null; };
const STARTERS = ['What is waiting on me?', 'Which modules are not ready?', 'Why is BARO-IN not ready?', 'Who can approve BARO-IN?', 'Automate FUEL-MON every 24 hours'];

export function Assistant({ runId }: { runId?: string }) {
  const { api, meta, go, setFocus, can, say } = useApp();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(false);
  const recRef = useRef<Rec | null>(null); const mediaRef = useRef<MediaRecorder | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const serverStt = api.mode === 'server' && !!meta.voice?.serverStt && !!api.transcribe;
  const voiceOk = serverStt || !!SpeechRec();
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, busy]);

  const ask = async (text: string, via: 'voice' | 'text' = 'text') => {
    const t = text.trim(); if (!t || busy) return;
    setMsgs(m => [...m, { role: 'user', text: t, via }]); setQ(''); setBusy(true);
    try {
      const a = await api.ask(t, runId);
      setMsgs(m => [...m, { role: 'assistant', answer: a }]);
      if ((speak || via === 'voice') && 'speechSynthesis' in globalThis) {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(a.sentences.slice(0, 3).map(s => s.text).join(' ').replace(/\b([A-Z]{2,})-([A-Z]{2,})\b/g, '$1 $2'));
        u.rate = 1.02; speechSynthesis.speak(u);
      }
    } catch (e) { setMsgs(m => [...m, { role: 'error', text: e instanceof Error ? e.message : String(e) }]); }
    finally { setBusy(false); }
  };

  const listen = async () => {
    if (listening) { recRef.current?.stop(); mediaRef.current?.stop(); return; }
    if (serverStt) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = new MediaRecorder(stream); const chunks: Blob[] = [];
        rec.ondataavailable = e => chunks.push(e.data);
        rec.onstop = async () => { stream.getTracks().forEach(t => t.stop()); setListening(false); try { const text = await api.transcribe!(new Blob(chunks, { type: rec.mimeType })); if (text) ask(text, 'voice'); } catch (e) { say(e instanceof Error ? e.message : String(e), true); } };
        mediaRef.current = rec; rec.start(); setListening(true); setTimeout(() => rec.state === 'recording' && rec.stop(), 15000);
      } catch { say('The microphone is blocked. Allow it in the browser, or type the question.', true); }
      return;
    }
    const R = SpeechRec(); if (!R) return;
    const r = new R(); r.lang = navigator.language || 'en-US'; r.interimResults = false;
    r.onresult = e => { const text = e.results[0]?.[0]?.transcript ?? ''; if (text) ask(text, 'voice'); };
    r.onend = () => setListening(false);
    r.onerror = e => { setListening(false); say(e.error === 'not-allowed' ? 'The microphone is blocked. Allow it in the browser, or type the question.' : `Voice input stopped: ${e.error}.`, true); };
    recRef.current = r; setListening(true); try { r.start(); } catch { setListening(false); }
  };

  const openCite = (c: Citation) => {
    if (c.kind === 'run' || c.kind === 'decision') go(c.runId);
    else if (c.kind === 'finding') { setFocus(c.findingId); go(c.runId); }
    else if (c.kind === 'policy') go('policies');
    else go('schedules');
  };

  const createSchedule = async (a: Answer) => {
    const p = a.proposal!;
    try { await api.saveSchedule({ name: p.name, datasetId: p.datasetId, modules: p.modules, layer2: 'auto', recurrence: p.recurrence, timezone: p.timezone, enabled: true, skipIfPending: true, notifyOn: ['NO', 'failed'] });
      say(`Schedule "${p.name}" created. It runs by itself from now on.`); setMsgs(m => [...m, { role: 'assistant', answer: { sentences: [{ text: `Done. "${p.name}" is on the Schedules page and will run by itself.`, cites: [] }], citations: [], mode: 'rules', followUps: [] } }]); }
    catch (e) { say(e instanceof Error ? e.message : String(e), true); }
  };

  return <>
    {!open && <button className="ask-fab" onClick={() => setOpen(true)} aria-label="Open the audit assistant"><span aria-hidden="true">?</span> Ask about audits</button>}
    {open && <aside className="assistant" aria-label="Audit assistant">
      <header><div><b>Audit assistant</b><small className="dim">Answers only from audits you can see, with sources</small></div>
        <label className="check sm" title="Read answers aloud"><input type="checkbox" checked={speak} onChange={e => { setSpeak(e.target.checked); if (!e.target.checked) speechSynthesis?.cancel(); }} />Speak</label>
        <button className="btn ghost sm" onClick={() => { setOpen(false); speechSynthesis?.cancel?.(); }}>Close</button></header>
      <div className="as-body" role="log" aria-live="polite">
        {!msgs.length && <div className="as-empty"><p className="dim2 sm">Ask by typing or with the microphone{runId ? '. Questions without a module name are about the audit you have open' : ''}.</p>
          <div className="as-chips">{STARTERS.map(s => <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>)}</div></div>}
        {msgs.map((m, i) => m.role === 'user' ? <div key={i} className="as-q">{m.via === 'voice' && <span className="dim sm">🎙 </span>}{m.text}</div>
          : m.role === 'error' ? <div key={i} className="as-a err-text sm">{m.text}</div>
          : <div key={i} className="as-a">
            {m.answer.sentences.map((s, k) => <p key={k}>{s.text}{s.cites.map(c => <button key={c} className="cite" title={`${m.answer.citations[c].label} · ${m.answer.citations[c].detail}`} onClick={() => openCite(m.answer.citations[c])}>{c + 1}</button>)}</p>)}
            {m.answer.citations.length > 0 && <details className="srcs"><summary>{m.answer.citations.length} source{m.answer.citations.length > 1 ? 's' : ''}{m.answer.mode === 'llm' ? ' · written by the LLM, citations checked' : ''}</summary>
              <ol>{m.answer.citations.map((c, k) => <li key={k}><button className="link-btn" onClick={() => openCite(c)}>{c.label}</button> <span className="dim">{c.detail}</span>{c.kind === 'finding' && c.evidence.length > 0 && <div className="mono dim ev-small">{c.evidence.join(' · ')}</div>}</li>)}</ol></details>}
            {m.answer.proposal && <div className="proposal"><b>Automate: {m.answer.proposal.name}</b><span className="sm dim2">{m.answer.proposal.datasetName} · {m.answer.proposal.timezone}</span>
              {can('schedule.manage') ? <button className="btn primary sm" onClick={() => createSchedule(m.answer)}>Create this schedule</button> : <span className="sm dim">You need the schedule permission; an administrator can create it.</span>}</div>}
            {m.answer.followUps.length > 0 && <div className="as-chips">{m.answer.followUps.map(f => <button key={f} className="chip" onClick={() => ask(f)}>{f}</button>)}</div>}
          </div>)}
        {busy && <div className="as-a dim"><span className="spin sm" /> Looking through the audits…</div>}
        <div ref={endRef} />
      </div>
      <form className="as-input" onSubmit={e => { e.preventDefault(); ask(q); }}>
        <button type="button" className={'btn mic' + (listening ? ' on' : '')} onClick={listen} disabled={!voiceOk || busy} aria-pressed={listening}
          title={voiceOk ? (listening ? 'Stop and send' : 'Ask by voice') : 'Voice input is not available in this browser'}>{listening ? '■' : '🎙'}</button>
        <input aria-label="Question" value={q} onChange={e => setQ(e.target.value)} placeholder={listening ? 'Listening…' : 'Ask about any audit'} />
        <button className="btn primary" type="submit" disabled={busy || !q.trim()}>Ask</button>
      </form>
    </aside>}
  </>;
}
