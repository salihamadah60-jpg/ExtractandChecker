import { useState } from "react";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";

export default function Login() {
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<"create" | "login">("login");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError("أدخل اسم مساحة العمل"); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/workspaces/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "حدث خطأ");
      localStorage.setItem("workspace_key", data.accessKey);
      localStorage.setItem("workspace_name", data.name);
      navigate("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) { setError("أدخل مفتاح الوصول"); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/workspaces/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessKey: key.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "مفتاح غير صالح");
      localStorage.setItem("workspace_key", data.accessKey);
      localStorage.setItem("workspace_name", data.name);
      navigate("/");
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
          <div className="text-4xl mb-2">💬</div>
          <h1 className="text-2xl font-bold text-foreground">Link Checker Pro</h1>
          <p className="text-muted-foreground text-sm mt-1">فاحص روابط واتساب وتيليغرام</p>
        </div>

        <div className="flex rounded-lg overflow-hidden border border-border mb-6">
          <button
            className={`flex-1 py-2 text-sm font-medium transition-colors ${mode === "login" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
            onClick={() => { setMode("login"); setError(""); }}
          >
            تسجيل الدخول
          </button>
          <button
            className={`flex-1 py-2 text-sm font-medium transition-colors ${mode === "create" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
            onClick={() => { setMode("create"); setError(""); }}
          >
            مساحة جديدة
          </button>
        </div>

        {mode === "login" ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">مفتاح الوصول</label>
              <input
                type="text"
                value={key}
                onChange={e => setKey(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary font-mono"
                data-testid="input-access-key"
                onKeyDown={e => e.key === "Enter" && handleLogin(e as any)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
              data-testid="button-login"
            >
              {loading ? "جارٍ الدخول..." : "دخول"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">اسم مساحة العمل</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="مثال: فريق المبيعات"
                className="w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                data-testid="input-workspace-name"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
              data-testid="button-create-workspace"
            >
              {loading ? "جارٍ الإنشاء..." : "إنشاء مساحة عمل"}
            </button>
          </form>
        )}

        {mode === "create" && (
          <p className="text-xs text-muted-foreground mt-4 text-center">
            ستحصل على مفتاح وصول خاص احتفظ به بأمان
          </p>
        )}
      </div>
    </div>
  );
}
