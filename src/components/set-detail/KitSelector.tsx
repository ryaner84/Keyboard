"use client";

interface Kit {
  id: string;
  name: string;
  type: string;
}

interface KitSelectorProps {
  kits: Kit[];
  selectedKitId: string;
  onChange: (id: string) => void;
}

export function KitSelector({ kits, selectedKitId, onChange }: KitSelectorProps) {
  if (kits.length <= 1) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {kits.map((kit) => (
        <button
          key={kit.id}
          onClick={() => onChange(kit.id)}
          className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all ${
            selectedKitId === kit.id
              ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
              : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300 hover:text-indigo-600"
          }`}
        >
          {kit.name}
        </button>
      ))}
    </div>
  );
}
