import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyAdminToken } from "@/lib/auth";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get("admin_session")?.value;

  // Login page is excluded from this check by Next.js nested routing
  if (!token || !verifyAdminToken(token)) {
    redirect("/admin/login");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between">
        <span className="font-semibold text-gray-800">GMK Tracker Admin</span>
        <form action="/api/admin/auth" method="POST">
          <a
            href="/api/admin/logout"
            className="text-sm text-gray-500 hover:text-red-600 transition-colors"
          >
            Sign out
          </a>
        </form>
      </div>
      <div className="max-w-5xl mx-auto px-4 py-8">{children}</div>
    </div>
  );
}
