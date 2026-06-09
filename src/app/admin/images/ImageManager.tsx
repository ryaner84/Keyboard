"use client";

import { useMemo, useState } from "react";

interface SetEntry {
  slug: string;
  name: string;
  status: string;
  images: string[];
}

export function ImageManager({ sets }: { sets: SetEntry[] }) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? sets.filter((s) => s.name.toLowerCase().includes(q)) : sets;
    return list.slice(0, 100);
  }, [search, sets]);

  const active = sets.find((s) => s.slug === selected) ?? null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
      {/* Set list */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4">
        <input
          type="text"
          placeholder="Search sets…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <div className="space-y-1 max-h-[60vh] overflow-y-auto">
          {filtered.map((s) => (
            <button
              key={s.slug}
              onClick={() => setSelected(s.slug)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                selected === s.slug ? "bg-indigo-50 text-indigo-700" : "hover:bg-gray-50 text-gray-700"
              }`}
            >
              <span className="font-medium">{s.name}</span>
              <span className="ml-2 text-xs text-gray-400">{s.images.length} img</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-gray-400 px-3 py-4">No sets match.</p>
          )}
        </div>
      </div>

      {/* Editor */}
      <div>
        {active ? (
          <SetImageEditor key={active.slug} set={active} />
        ) : (
          <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center text-gray-400">
            Select a set to edit its images.
          </div>
        )}
      </div>
    </div>
  );
}

function SetImageEditor({ set }: { set: SetEntry }) {
  const [images, setImages] = useState<string[]>(set.images);
  const [newUrl, setNewUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const addUrl = () => {
    const u = newUrl.trim();
    if (!/^https?:\/\//i.test(u)) {
      setMessage("URL must start with http(s)://");
      return;
    }
    if (images.includes(u)) {
      setMessage("Already added.");
      return;
    }
    setImages([...images, u]);
    setNewUrl("");
    setMessage(null);
  };

  const remove = (i: number) => setImages(images.filter((_, idx) => idx !== i));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= images.length) return;
    const next = [...images];
    [next[i], next[j]] = [next[j], next[i]];
    setImages(next);
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/sets/${set.slug}/images`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setImages(data.images);
      setMessage("Saved ✓");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-900">{set.name}</h2>
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {message && (
        <p className={`text-sm mb-3 ${message.includes("✓") ? "text-green-600" : "text-red-500"}`}>
          {message}
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        {images.map((img, i) => (
          <div key={img} className="relative group border border-gray-100 rounded-lg overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img} alt={`${set.name} ${i + 1}`} className="w-full h-24 object-cover bg-gray-50" />
            {i === 0 && (
              <span className="absolute top-1 left-1 px-1.5 py-0.5 bg-indigo-600 text-white text-[10px] rounded">
                Hero
              </span>
            )}
            <div className="absolute inset-x-0 bottom-0 flex justify-between bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
              <button onClick={() => move(i, -1)} className="px-2 text-white text-xs" aria-label="Move left">‹</button>
              <button onClick={() => remove(i)} className="px-2 text-white text-xs" aria-label="Remove">✕</button>
              <button onClick={() => move(i, 1)} className="px-2 text-white text-xs" aria-label="Move right">›</button>
            </div>
          </div>
        ))}
        {images.length === 0 && (
          <p className="col-span-full text-sm text-gray-400 py-6 text-center">No images yet.</p>
        )}
      </div>

      <div className="flex gap-2">
        <input
          type="url"
          placeholder="Paste image URL (e.g. gmk.net render)…"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addUrl()}
          className="flex-1 px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <button
          onClick={addUrl}
          className="px-4 py-2 border border-gray-200 text-gray-700 text-sm font-medium rounded-xl hover:border-indigo-300 transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  );
}
