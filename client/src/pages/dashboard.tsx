import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowRight, Database, Users, CheckCircle2, XCircle, Clock,
  TrendingUp, BookOpen, Loader2, RefreshCw,
  MessageSquare, UserPlus, Link2, Moon, Thermometer,
  PauseCircle, Activity, AlertTriangle,
} from "lucide-react";

interface DashboardStats {
  byStatus: { Pending: number; Joined: number; Ignored: number; Left: number };
  bySource: Record<string, number>;
  trend: { date: string; count: number }[];
  recent: {
    url: string; status: string; name?: string; members?: number;
    source: string; addedAt: string; groupJid?: string;
  }[];
  total: number;
  todayCount: number;
  readerStats: {
    status: string; messagesReceived: number; messagesSkippedAds: number;
    linksFound: number; linksNew: number; pipelineRuns?: number; startedAt: string;
  } | null;
  joinProgress: {
    status: string; total: number; processed: number;
    joined: number; ignored: number; failed: number; skipped_ads: number;
    startedAt: string; completedAt?: string;
    windowNumber: number; currentLink?: string; stopReason?: string;
    nextJoinAt?: string; sleepUntil?: string; cooldownUntil?: string;
    telemetry?: { avgLatencyMs: number; lastLatencyMs: number; cooldownActive: boolean; warning?: string };
  } | null;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  Pending: { label: "معلق", color: "text-orange-600", bg: "bg-orange-50 dark:bg-orange-900/20", icon: <Clock className="w-4 h-4" /> },
  Joined: { label: "منضم", color: "text-green-600", bg: "bg-green-50 dark:bg-green-900/20", icon: <CheckCircle2 className="w-4 h-4" /> },
  Ignored: { label: "تجاهل", color: "text-muted-foreground", bg: "bg-muted/50", icon: <XCircle className="w-4 h-4" /> },
  Left: { label: "خرج", color: "text-red-600", bg: "bg-red-50 dark:bg-red-900/20", icon: <XCircle className="w-4 h-4" /> },
};

const SOURCE_LABELS: Record<string, string> = {
  upload: "رفع ملف",
  description: "وصف مجموعة",
  message: "رسالة مباشرة",
  manual: "يدوي",
};

function TrendBar({ trend }: { trend: { date: string; count: number }[] }) {
  if (!trend.length) return <p className="text-sm text-muted-foreground text-center py-4">لا توجد بيانات بعد</p>;
  const max = Math.max(...trend.map((d) => d.count), 1);
  const last14 = (() => {
    const result: { date: string; count: number }[] = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const found = trend.find((t) => t.date === dateStr);
      result.push({ date: dateStr, count: found?.count ?? 0 });
    }
    return result;
  })();
  return (
    <div className="flex items-end gap-1 h-24 w-full">
      {last14.map((d) => {
        const pct = Math.round((d.count / max) * 100);
        const label = d.date.slice(5); // MM-DD
        return (
          <div key={d.date} className="flex flex-col items-center flex-1 gap-1 group relative">
            <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-foreground text-background text-xs px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
              {d.count} رابط
            </div>
            <div
              className="w-full rounded-t transition-all"
              style={{
                height: `${Math.max(pct, 4)}%`,
                backgroundColor: d.count > 0 ? "hsl(var(--primary))" : "hsl(var(--muted))",
                opacity: d.count > 0 ? 0.85 : 0.3,
              }}
            />
            <span className="text-[9px] text-muted-foreground">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const { data, isLoading, refetch, isFetching, isError, error } = useQuery<DashboardStats>({
    queryKey: ["/api/dashboard/stats"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/stats", { credentials: "include" });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      return res.json() as Promise<DashboardStats>;
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: 1,
  });

  const statusOrder: (keyof DashboardStats["byStatus"])[] = ["Pending", "Joined", "Left", "Ignored"];

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      {/* Header */}
      <div className="border-b bg-card sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Database className="w-4 h-4 text-primary" />
            </div>
            <div>
              <h1 className="font-bold text-base leading-none">لوحة التحكم</h1>
              <p className="text-xs text-muted-foreground mt-0.5">إحصاءات المستودع والأنابيب</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-dashboard">
              <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
            <Link href="/">
              <Button variant="outline" size="sm" data-testid="link-back-home">
                <ArrowRight className="w-4 h-4 ml-1.5" />رجوع
              </Button>
            </Link>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
            <p className="text-muted-foreground">جاري تحميل الإحصاءات...</p>
          </div>
        ) : !data ? (
          <Card><CardContent className="py-12 text-center text-muted-foreground">تعذّر تحميل البيانات</CardContent></Card>
        ) : (
          <>
            {/* Top summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Card className="col-span-2 md:col-span-1 bg-primary/5 border-primary/20">
                <CardContent className="p-4 text-center">
                  <p className="text-3xl font-bold text-primary">{data.total.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground mt-1">إجمالي الروابط</p>
                </CardContent>
              </Card>
              {statusOrder.map((s) => {
                const cfg = STATUS_CONFIG[s];
                return (
                  <Card key={s} className={`${cfg.bg} border-0`}>
                    <CardContent className="p-4 text-center">
                      <div className={`flex justify-center mb-1 ${cfg.color}`}>{cfg.icon}</div>
                      <p className={`text-2xl font-bold ${cfg.color}`}>{data.byStatus[s].toLocaleString()}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{cfg.label}</p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Trend chart + Source breakdown */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card className="md:col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-primary" />
                    الروابط المضافة — آخر 14 يوم
                    {data.todayCount > 0 && (
                      <Badge variant="secondary" className="mr-auto text-xs">اليوم: {data.todayCount}</Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pb-4 pt-6">
                  <TrendBar trend={data.trend} />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Link2 className="w-4 h-4 text-primary" />
                    مصدر الروابط
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {Object.entries(data.bySource).length === 0 ? (
                    <p className="text-sm text-muted-foreground">لا توجد بيانات</p>
                  ) : (
                    Object.entries(data.bySource)
                      .sort(([, a], [, b]) => b - a)
                      .map(([src, count]) => {
                        const total = Object.values(data.bySource).reduce((a, b) => a + b, 0);
                        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                        return (
                          <div key={src}>
                            <div className="flex justify-between text-xs mb-1">
                              <span className="text-muted-foreground">{SOURCE_LABELS[src] ?? src}</span>
                              <span className="font-medium">{count} ({pct}%)</span>
                            </div>
                            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                              <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Reader + Join Manager status */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Message Reader */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-primary" />
                    القارئ التلقائي
                    {data.readerStats ? (
                      <Badge variant={data.readerStats.status === "running" ? "default" : "secondary"} className="mr-auto text-xs">
                        {data.readerStats.status === "running" ? "يعمل" : "متوقف"}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="mr-auto text-xs">غير نشط</Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {data.readerStats ? (
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div className="bg-muted/50 rounded-lg p-2.5">
                        <p className="text-lg font-bold">{data.readerStats.messagesReceived.toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground">رسائل استُقبلت</p>
                      </div>
                      <div className="bg-muted/50 rounded-lg p-2.5">
                        <p className="text-lg font-bold text-green-600">{data.readerStats.linksNew.toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground">روابط جديدة</p>
                      </div>
                      <div className="bg-muted/50 rounded-lg p-2.5">
                        <p className="text-lg font-bold text-muted-foreground">{data.readerStats.messagesSkippedAds.toLocaleString()}</p>
                        <p className="text-xs text-muted-foreground">رسائل إعلانية (تجاهل)</p>
                      </div>
                      <div className="bg-muted/50 rounded-lg p-2.5">
                        <p className="text-lg font-bold text-primary">{data.readerStats.pipelineRuns ?? 0}</p>
                        <p className="text-xs text-muted-foreground">تشغيلات pipeline</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground py-2">لم يبدأ القارئ بعد في هذه الجلسة</p>
                  )}
                </CardContent>
              </Card>

              {/* Join Manager */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <UserPlus className="w-4 h-4 text-primary" />
                    مدير الانضمام
                    {data.joinProgress ? (
                      <Badge
                        variant={
                          data.joinProgress.status === "running" ? "default" :
                          data.joinProgress.status === "done" ? "secondary" : "outline"
                        }
                        className={`mr-auto text-xs ${
                          data.joinProgress.status === "sleeping" ? "text-blue-600 border-blue-300" :
                          data.joinProgress.status === "cooldown" ? "text-orange-600 border-orange-300" :
                          data.joinProgress.status === "paused" ? "text-yellow-600 border-yellow-300" :
                          data.joinProgress.status === "waiting" ? "text-sky-600 border-sky-300" : ""
                        }`}
                      >
                        {data.joinProgress.status === "running"  ? "يعمل" :
                         data.joinProgress.status === "waiting"  ? "انتظار" :
                         data.joinProgress.status === "sleeping" ? "نائم" :
                         data.joinProgress.status === "cooldown" ? "تبريد" :
                         data.joinProgress.status === "paused"   ? "متوقف مؤقتاً" :
                         data.joinProgress.status === "done"     ? "مكتمل" :
                         data.joinProgress.status === "stopped"  ? "موقوف" : "خطأ"}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="mr-auto text-xs">غير نشط</Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {data.joinProgress ? (
                    <div className="space-y-3">
                      {/* Stats grid */}
                      <div className="grid grid-cols-4 gap-1.5 text-sm">
                        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-2 text-center">
                          <p className="text-base font-bold text-green-600">{data.joinProgress.joined}</p>
                          <p className="text-[10px] text-muted-foreground">انضم</p>
                        </div>
                        <div className="bg-muted/50 rounded-lg p-2 text-center">
                          <p className="text-base font-bold text-muted-foreground">{data.joinProgress.ignored}</p>
                          <p className="text-[10px] text-muted-foreground">تجاهل</p>
                        </div>
                        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-2 text-center">
                          <p className="text-base font-bold text-red-600">{data.joinProgress.failed}</p>
                          <p className="text-[10px] text-muted-foreground">فشل</p>
                        </div>
                        <div className="bg-orange-50 dark:bg-orange-900/20 rounded-lg p-2 text-center">
                          <p className="text-base font-bold text-orange-500">{data.joinProgress.skipped_ads}</p>
                          <p className="text-[10px] text-muted-foreground">إعلان</p>
                        </div>
                      </div>

                      {/* Progress bar */}
                      <div>
                        <div className="flex justify-between text-xs text-muted-foreground mb-1">
                          <span>نافذة #{data.joinProgress.windowNumber}</span>
                          <span>{data.joinProgress.processed} / {data.joinProgress.total}</span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full transition-all"
                            style={{ width: `${data.joinProgress.total > 0 ? Math.round((data.joinProgress.processed / data.joinProgress.total) * 100) : 0}%` }}
                          />
                        </div>
                      </div>

                      {/* Status info rows */}
                      {data.joinProgress.status === "sleeping" && data.joinProgress.sleepUntil && (
                        <div className="flex items-center gap-2 text-xs bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2 text-blue-700 dark:text-blue-300">
                          <Moon className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>نائم حتى {new Date(data.joinProgress.sleepUntil).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}</span>
                        </div>
                      )}
                      {data.joinProgress.status === "cooldown" && data.joinProgress.cooldownUntil && (
                        <div className="flex items-center gap-2 text-xs bg-orange-50 dark:bg-orange-900/20 rounded-lg px-3 py-2 text-orange-700 dark:text-orange-300">
                          <Thermometer className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>تبريد حتى {new Date(data.joinProgress.cooldownUntil).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}</span>
                        </div>
                      )}
                      {data.joinProgress.status === "paused" && (
                        <div className="flex items-center gap-2 text-xs bg-yellow-50 dark:bg-yellow-900/20 rounded-lg px-3 py-2 text-yellow-700 dark:text-yellow-300">
                          <PauseCircle className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>{data.joinProgress.stopReason ?? "متوقف مؤقتاً"}</span>
                        </div>
                      )}
                      {(data.joinProgress.status === "waiting" || data.joinProgress.status === "running") && data.joinProgress.nextJoinAt && (
                        <div className="flex items-center gap-2 text-xs bg-sky-50 dark:bg-sky-900/20 rounded-lg px-3 py-2 text-sky-700 dark:text-sky-300">
                          <Clock className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>الانضمام التالي: {new Date(data.joinProgress.nextJoinAt).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}</span>
                        </div>
                      )}
                      {data.joinProgress.currentLink && (
                        <div className="flex items-center gap-2 text-xs bg-muted/40 rounded-lg px-3 py-2">
                          <Activity className="w-3.5 h-3.5 text-primary flex-shrink-0 animate-pulse" />
                          <span className="truncate text-muted-foreground font-mono">{data.joinProgress.currentLink.replace("https://chat.whatsapp.com/", "")}</span>
                        </div>
                      )}
                      {data.joinProgress.telemetry?.warning && (
                        <div className="flex items-center gap-2 text-xs bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2 text-red-600">
                          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>{data.joinProgress.telemetry.warning}</span>
                        </div>
                      )}
                      {data.joinProgress.telemetry && (
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1">
                          <span>زمن الاستجابة: {Math.round(data.joinProgress.telemetry.avgLatencyMs)}ms</span>
                          <span>آخر: {Math.round(data.joinProgress.telemetry.lastLatencyMs)}ms</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground py-2">لم يبدأ مدير الانضمام بعد في هذه الجلسة</p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Recent activity */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-primary" />
                  آخر الروابط المضافة
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {data.recent.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">لا توجد روابط في المستودع</p>
                ) : (
                  <div className="divide-y">
                    {data.recent.map((r, i) => {
                      const cfg = STATUS_CONFIG[r.status] ?? STATUS_CONFIG.Ignored;
                      const code = r.url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]{6,})/)?.[1];
                      const shortUrl = code ? `...${code.slice(-8)}` : r.url.slice(-20);
                      const addedAt = new Date(r.addedAt);
                      const timeStr = addedAt.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
                      const dateStr = addedAt.toLocaleDateString("ar-SA", { month: "short", day: "numeric" });
                      return (
                        <div key={i} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors" data-testid={`row-recent-${i}`}>
                          <div className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.color} flex-shrink-0`}>
                            {cfg.icon}
                            <span>{cfg.label}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{r.name ?? shortUrl}</p>
                            {r.name && <p className="text-xs text-muted-foreground font-mono">{shortUrl}</p>}
                          </div>
                          {r.members && (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground flex-shrink-0">
                              <Users className="w-3 h-3" />
                              <span>{r.members.toLocaleString()}</span>
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground flex-shrink-0 text-left">
                            <p>{timeStr}</p>
                            <p>{dateStr}</p>
                          </div>
                          <Badge variant="outline" className="text-[10px] flex-shrink-0">{SOURCE_LABELS[r.source] ?? r.source}</Badge>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
