import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";

const ADMIN_KEY_LS = "admin_key";

function getAdminKey(): string {
  return localStorage.getItem(ADMIN_KEY_LS) ?? "";
}

async function adminFetch(path: string, opts: RequestInit = {}) {
  const key = getAdminKey();
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Key": key,
      ...(opts.headers as any),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "حدث خطأ");
  return data;
}

// ── Login ─────────────────────────────────────────────────────────────────────
function AdminLogin({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) { setError("أدخل مفتاح المشرف"); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminKey: key.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "مفتاح غير صالح");
      localStorage.setItem(ADMIN_KEY_LS, data.adminKey);
      onLogin();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div dir="rtl" className="min-h-screen flex items-center justify-center bg-[hsl(var(--background))]">
      <div className="w-full max-w-sm mx-4 bg-card rounded-2xl shadow-lg border border-border p-8">
        <div className="text-center mb-8">
          <div className="text-4xl mb-2">🛡️</div>
          <h1 className="text-2xl font-bold text-foreground">لوحة المشرفين</h1>
          <p className="text-muted-foreground text-sm mt-1">Link Checker Pro — Admin</p>
        </div>
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">مفتاح المشرف</label>
            <input
              type="text"
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary font-mono"
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {loading ? "جارٍ الدخول..." : "دخول"}
          </button>
        </form>
        <p className="text-xs text-muted-foreground mt-4 text-center">
          مفتاح المشرف متاح في سجل الخادم عند أول تشغيل
        </p>
      </div>
    </div>
  );
}

// ── Central Links Tab ─────────────────────────────────────────────────────────
function CentralLinksTab() {
  const [links, setLinks] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [minMembers, setMinMembers] = useState("");
  const [page, setPage] = useState(0);
  const limit = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        skip: String(page * limit),
        limit: String(limit),
        ...(search ? { search } : {}),
        ...(category ? { category } : {}),
        ...(minMembers ? { minMembers } : {}),
      });
      const [data, statsData] = await Promise.all([
        adminFetch(`/api/admin/central-links?${params}`),
        adminFetch("/api/admin/central-links/stats"),
      ]);
      setLinks(data.docs ?? []);
      setTotal(data.total ?? 0);
      setStats(statsData);
    } catch (err: any) {
      console.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, search, category, minMembers]);

  useEffect(() => { load(); }, [load]);

  async function handleDownload() {
    const key = getAdminKey();
    const params = new URLSearchParams({
      ...(search ? { search } : {}),
      ...(category ? { category } : {}),
      ...(minMembers ? { minMembers } : {}),
    });
    window.open(`/api/admin/central-links/download?${params}&adminKey=${key}`, "_blank");
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="space-y-4">
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "المجموع", value: stats.total, color: "text-foreground" },
            { label: "مجموعات (>50)", value: stats.groups, color: "text-primary" },
            { label: "إعلانات (10-50)", value: stats.ads, color: "text-orange-500" },
          ].map(s => (
            <div key={s.label} className="bg-card border border-border rounded-xl p-3 text-center">
              <p className={`text-2xl font-bold ${s.color}`}>{s.value?.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <input
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0); }}
          placeholder="بحث بالاسم أو الرابط..."
          className="flex-1 min-w-48 px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <select
          value={category}
          onChange={e => { setCategory(e.target.value); setPage(0); }}
          className="px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="">الكل</option>
          <option value="group">مجموعات</option>
          <option value="ad">إعلانات</option>
        </select>
        <input
          type="number"
          value={minMembers}
          onChange={e => { setMinMembers(e.target.value); setPage(0); }}
          placeholder="أدنى أعضاء"
          className="w-32 px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <button
          onClick={handleDownload}
          className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
        >
          ⬇️ تحميل DOCX
        </button>
      </div>

      {/* Table */}
      <div className="border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">#</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">الرابط</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">الاسم</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">الأعضاء</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">النوع</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">تاريخ الإضافة</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">جارٍ التحميل...</td></tr>
              ) : links.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">لا توجد روابط</td></tr>
              ) : links.map((link, i) => (
                <tr key={link._id} className="border-t border-border hover:bg-muted/30 transition-colors">
                  <td className="px-3 py-2 text-muted-foreground">{page * limit + i + 1}</td>
                  <td className="px-3 py-2 max-w-56">
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline font-mono text-xs break-all"
                    >
                      {link.url.replace("https://chat.whatsapp.com/", "wa/")}
                    </a>
                  </td>
                  <td className="px-3 py-2 max-w-40 truncate">{link.name || <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-3 py-2 text-center font-medium">{link.members ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                      link.category === "group"
                        ? "bg-primary/10 text-primary"
                        : "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
                    }`}>
                      {link.category === "group" ? "مجموعة" : "إعلان"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">
                    {link.addedAt ? new Date(link.addedAt).toLocaleDateString("ar") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} رابط — صفحة {page + 1} من {totalPages}
          </p>
          <div className="flex gap-2">
            <button
              disabled={page === 0}
              onClick={() => setPage(p => p - 1)}
              className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-40 transition-colors"
            >
              ← السابق
            </button>
            <button
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-40 transition-colors"
            >
              التالي →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Admins Tab ────────────────────────────────────────────────────────────────
function AdminsTab({ currentAdminId }: { currentAdminId: string }) {
  const [admins, setAdmins] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    try {
      const data = await adminFetch("/api/admin/list");
      setAdmins(data.admins ?? []);
    } catch (err: any) { setError(err.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim()) { setError("أدخل رقم الهاتف"); return; }
    setCreating(true); setError(""); setNewKey(null);
    try {
      const data = await adminFetch("/api/admin/add", {
        method: "POST",
        body: JSON.stringify({ phoneNumber: phone.trim(), name: name.trim() || undefined }),
      });
      setNewKey(data.admin.adminKey);
      setPhone(""); setName("");
      await load();
    } catch (err: any) { setError(err.message); }
    finally { setCreating(false); }
  }

  async function handleDelete(id: string) {
    if (!confirm("هل تريد حذف هذا المشرف؟")) return;
    try {
      await adminFetch(`/api/admin/${id}`, { method: "DELETE" });
      await load();
    } catch (err: any) { setError(err.message); }
  }

  function handleCopy() {
    if (!newKey) return;
    navigator.clipboard.writeText(newKey).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }

  return (
    <div className="space-y-6">
      {/* Add admin form */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="font-semibold text-foreground mb-3">إضافة مشرف جديد</h3>
        <form onSubmit={handleCreate} className="flex gap-2 flex-wrap">
          <input
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="رقم الهاتف (مثال: 967771234567)"
            className="flex-1 min-w-48 px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="الاسم (اختياري)"
            className="flex-1 min-w-32 px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            type="submit"
            disabled={creating}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {creating ? "جارٍ الإضافة..." : "إضافة"}
          </button>
        </form>
        {error && <p className="text-sm text-destructive mt-2">{error}</p>}
        {newKey && (
          <div className="mt-3 p-3 bg-muted rounded-lg border border-border">
            <p className="text-xs font-medium text-foreground mb-1">🔑 مفتاح المشرف الجديد — احتفظ به:</p>
            <p className="font-mono text-sm break-all text-foreground">{newKey}</p>
            <button
              onClick={handleCopy}
              className="mt-2 px-3 py-1 rounded-lg border border-border text-sm hover:bg-muted/70 transition-colors"
            >
              {copied ? "✓ تم النسخ" : "📋 نسخ"}
            </button>
          </div>
        )}
      </div>

      {/* Admins list */}
      <div className="border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground">رقم الهاتف</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground">الاسم</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground">تاريخ الإنشاء</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">جارٍ التحميل...</td></tr>
            ) : admins.map(admin => (
              <tr key={admin._id} className="border-t border-border hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-mono text-sm">{admin.phoneNumber}</td>
                <td className="px-4 py-3">{admin.name || <span className="text-muted-foreground">—</span>}</td>
                <td className="px-4 py-3 text-muted-foreground text-xs">
                  {admin.createdAt ? new Date(admin.createdAt).toLocaleDateString("ar") : "—"}
                </td>
                <td className="px-4 py-3">
                  {admin._id !== currentAdminId ? (
                    <button
                      onClick={() => handleDelete(admin._id)}
                      className="px-2 py-1 rounded text-xs text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      حذف
                    </button>
                  ) : (
                    <span className="text-xs text-primary font-medium">أنت</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Sessions & Workspaces Tab ─────────────────────────────────────────────────
function SessionsTab() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const d = await adminFetch("/api/admin/workspaces");
        setData(d);
      } catch (err: any) { setError(err.message); }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <div className="py-8 text-center text-muted-foreground">جارٍ التحميل...</div>;
  if (error) return <div className="py-8 text-center text-destructive">{error}</div>;

  const workspaces: any[] = data?.workspaces ?? [];
  const sessions: any[] = data?.sessions ?? [];

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-foreground">{workspaces.length}</p>
          <p className="text-sm text-muted-foreground mt-1">مساحة عمل</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-primary">{sessions.filter((s: any) => s.status === "connected").length}</p>
          <p className="text-sm text-muted-foreground mt-1">جلسة واتساب نشطة</p>
        </div>
      </div>

      {/* All WhatsApp Sessions */}
      <div>
        <h3 className="font-semibold text-foreground mb-3">جلسات واتساب</h3>
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">الجلسة</th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">رقم الهاتف</th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">الحالة</th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">المساحة</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">لا توجد جلسات</td></tr>
              ) : sessions.map((s: any) => (
                <tr key={s.id} className="border-t border-border hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{s.displayName || s.id.slice(0, 8)}</td>
                  <td className="px-4 py-3 font-medium">{s.phoneNumber ? `+${s.phoneNumber}` : <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                      s.status === "connected"
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : s.status === "connecting"
                        ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${s.status === "connected" ? "bg-green-500" : s.status === "connecting" ? "bg-yellow-500" : "bg-gray-400"}`} />
                      {s.status === "connected" ? "متصل" : s.status === "connecting" ? "يتصل..." : "منقطع"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{s.workspaceId || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Workspaces */}
      <div>
        <h3 className="font-semibold text-foreground mb-3">مساحات العمل</h3>
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">الاسم</th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">المعرف</th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">تاريخ الإنشاء</th>
                <th className="px-4 py-2 text-right font-medium text-muted-foreground">الجلسة النشطة</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">لا توجد مساحات</td></tr>
              ) : workspaces.map((ws: any) => {
                const linked = sessions.filter((s: any) => s.workspaceId === ws._id);
                return (
                  <tr key={ws._id} className="border-t border-border hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-medium">{ws.name}</td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{ws._id.slice(0, 8)}...</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {ws.createdAt ? new Date(ws.createdAt).toLocaleDateString("ar") : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {linked.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {linked.map((s: any) => (
                            <span key={s.id} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${
                              s.status === "connected" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-muted text-muted-foreground"
                            }`}>
                              {s.phoneNumber ? `+${s.phoneNumber}` : s.id.slice(0, 6)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">لا توجد جلسة</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Main Admin Dashboard ──────────────────────────────────────────────────────
export default function Admin() {
  const [, navigate] = useLocation();
  const [loggedIn, setLoggedIn] = useState(false);
  const [admin, setAdmin] = useState<any>(null);
  const [tab, setTab] = useState<"links" | "admins" | "sessions">("links");
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const key = localStorage.getItem(ADMIN_KEY_LS);
    if (!key) { setChecking(false); return; }
    fetch("/api/admin/me", { headers: { "X-Admin-Key": key } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.admin) { setAdmin(data.admin); setLoggedIn(true); }
      })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, []);

  function handleLogin() {
    const key = localStorage.getItem(ADMIN_KEY_LS);
    if (!key) return;
    fetch("/api/admin/me", { headers: { "X-Admin-Key": key } })
      .then(r => r.json())
      .then(data => { if (data?.admin) { setAdmin(data.admin); setLoggedIn(true); } });
  }

  function handleLogout() {
    localStorage.removeItem(ADMIN_KEY_LS);
    setLoggedIn(false);
    setAdmin(null);
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[hsl(var(--background))]">
        <div className="text-muted-foreground">جارٍ التحقق...</div>
      </div>
    );
  }

  if (!loggedIn) {
    return <AdminLogin onLogin={handleLogin} />;
  }

  return (
    <div dir="rtl" className="min-h-screen bg-[hsl(var(--background))]">
      {/* Header */}
      <div className="bg-card border-b border-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="text-2xl">🛡️</div>
          <div>
            <h1 className="font-bold text-foreground text-lg">لوحة المشرفين</h1>
            <p className="text-xs text-muted-foreground">{admin?.name || admin?.phoneNumber}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate("/")}
            className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted transition-colors"
          >
            ← الرئيسية
          </button>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 rounded-lg text-sm text-destructive hover:bg-destructive/10 transition-colors"
          >
            خروج
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-card border-b border-border px-4">
        <div className="flex gap-0 -mb-px">
          {[
            { key: "links", label: "🔗 الروابط المركزية" },
            { key: "admins", label: "👤 المشرفون" },
            { key: "sessions", label: "📱 المساحات والجلسات" },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key as any)}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto p-4">
        {tab === "links" && <CentralLinksTab />}
        {tab === "admins" && <AdminsTab currentAdminId={admin?._id ?? ""} />}
        {tab === "sessions" && <SessionsTab />}
      </div>
    </div>
  );
}
