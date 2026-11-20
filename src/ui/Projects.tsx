import { useEffect, useRef, useState } from 'react';
import { useStore } from '../core/store';
import { flyHome } from '../map/navigation';
import { runtime } from '../map/runtime';

// Project switcher in the top bar: each project is its own network (and its own
// tower schedule), saved separately in this browser.

export function ProjectMenu() {
  const projects = useStore((s) => s.projects);
  const projectId = useStore((s) => s.projectId);
  const count = useStore((s) => Object.keys(s.structures).length);
  const current = projects.find((p) => p.id === projectId);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [open]);

  const close = () => {
    setOpen(false);
    setCreating(null);
    setRenaming(null);
  };
  const goHome = () => window.setTimeout(() => runtime.map && flyHome(runtime.map), 50);

  const create = () => {
    if (creating == null) return;
    useStore.getState().newProject(creating || `Project ${projects.length + 1}`);
    close();
  };
  const openP = (id: string) => {
    useStore.getState().openProject(id);
    close();
    goHome();
  };
  const remove = (id: string, name: string) => {
    if (!confirm(`Delete the project "${name}" and everything in it? This cannot be undone.`)) return;
    const wasCurrent = id === useStore.getState().projectId;
    useStore.getState().deleteProject(id);
    if (wasCurrent) goHome();
  };
  const saveRename = () => {
    if (renaming) useStore.getState().renameProject(renaming.id, renaming.name);
    setRenaming(null);
  };

  return (
    <div className="proj" ref={box}>
      <button className="proj-btn" onClick={() => (open ? close() : setOpen(true))} title="Projects">
        <span className="muted">Project</span>
        <b>{current?.name ?? 'Untitled'}</b>
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="proj-menu panel">
          {creating == null ? (
            <button className="primary proj-new" onClick={() => setCreating('')}>＋ New project</button>
          ) : (
            <div className="proj-create">
              <input
                autoFocus placeholder={`Project ${projects.length + 1}`} value={creating}
                onChange={(e) => setCreating(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setCreating(null); }}
              />
              <button className="primary" onClick={create}>Create</button>
            </div>
          )}
          <p className="muted small">A new project starts with an empty map. Your current project is saved automatically.</p>
          <div className="proj-list">
            {projects.map((p) => (
              <div key={p.id} className={`proj-item ${p.id === projectId ? 'on' : ''}`}>
                {renaming?.id === p.id ? (
                  <input
                    autoFocus value={renaming.name}
                    onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setRenaming(null); }}
                    onBlur={saveRename}
                  />
                ) : (
                  <button className="proj-open" onClick={() => openP(p.id)} title={p.id === projectId ? 'Current project' : 'Open this project'}>
                    <b>{p.name}</b>
                    <span className="muted small">
                      {p.id === projectId ? `Open · ${count} structures` : `Edited ${new Date(p.updated).toLocaleDateString()}`}
                    </span>
                  </button>
                )}
                <button className="proj-icon" onClick={() => setRenaming({ id: p.id, name: p.name })} title="Rename">✎</button>
                <button className="proj-icon danger" onClick={() => remove(p.id, p.name)} title="Delete project">🗑</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
