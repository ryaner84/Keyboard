import { redirect } from "next/navigation";

export default function TrackerPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) value.forEach((entry) => nextParams.append(key, entry));
    else if (value != null) nextParams.set(key, value);
  }
  redirect(`/collection${nextParams.size ? `?${nextParams}` : ""}`);
}
