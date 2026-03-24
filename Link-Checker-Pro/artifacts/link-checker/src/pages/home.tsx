import { useState, useRef, useCallback, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Upload, FileText, Download, CheckCircle, Loader2,
  MessageCircle, Send, RefreshCw, ShieldCheck, Wifi, WifiOff, XCircle,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface LinkCategory {
  family: string[];
  mofeed: string[];
}

interface ProcessResult {
  tg: LinkCategory;
  wa: LinkCategory;
  stats: {
    totalTg: number;
    totalWa: number;
    duplicatesRemoved: number;
  };
}

interface SingleCheck {
  active: boolean | null;
  name: string | null;
}

interface CheckState {
  running: boolean;
  checked: number;
  total: number;
  totalActive: number;
  totalInactive: number;
  totalUnknown: number;
  results: Record<string, SingleCheck>;
}

function extractUrlFromEntry(entry: string): string {
  const m = entry.match(/https?:\/\/\S+$/);
  return m ? m[0] : "";
}

function normalizeUrlClient(url: string): string {
  return url.toLowerCase().replace(/[.,;!?،؛]+$/, "").replace(/\/+$/, "");
}

function getCheckResult(url: string, results: Record<string, SingleCheck>): SingleCheck | undefined {
  return results[url] ?? results[normalizeUrlClient(url)];
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`rounded-md px-4 py-3 flex flex-col gap-1 ${color}`}>
      <span className="text-2xl font-bold">{value}</span>
      <span className="text-xs font-medium opacity-80">{label}</span>
    </div>
  );
}

function LinkEntry({
  entry,
  colorClass,
  checkResult,
}: {
  entry: string;
  colorClass: string;
  checkResult?: SingleCheck;
}) {
  const hasResult = checkResult !== undefined;
  const isActive   = hasResult && checkResult.active === true;
  const isInactive = hasResult && checkResult.active === false;

  return (
    <div
      className={`text-xs font-mono py-1 px-2 rounded-sm break-all flex items-start gap-1.5 ${colorClass} ${
        isInactive ? "opacity-35 line-through" : ""
      }`}
      dir="auto"
    >
      {hasResult && (
        <span className="mt-0.5 flex-shrink-0 text-sm leading-none" title={
          isActive ? "نشط" : isInactive ? "منتهي / غير صالح" : "لا يمكن التحقق"
        }>
          {isActive ? "✅" : isInactive ? "❌" : "⚠️"}
        </span>
      )}
      <span className="flex-1">{entry}</span>
    </div>
  );
}

function LinkSection({
  title,
  links,
  icon,
  colorClass,
  checkResults,
}: {
  title: string;
  links: string[];
  icon: React.ReactNode;
  colorClass: string;
  checkResults: Record<string, SingleCheck>;
}) {
  if (links.length === 0) return null;
  const hasChecked = Object.keys(checkResults).length > 0;

  const activeCount = hasChecked
    ? links.filter((e) => getCheckResult(extractUrlFromEntry(e), checkResults)?.active === true).length
    : 0;
  const inactiveCount = hasChecked
    ? links.filter((e) => getCheckResult(extractUrlFromEntry(e), checkResults)?.active === false).length
    : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {icon}
        <span className="font-semibold text-sm">{title}</span>
        <Badge variant="secondary" className="text-xs">{links.length} إجمالي</Badge>
        {hasChecked && activeCount > 0 && (
          <Badge variant="outline" className="text-xs text-green-700 border-green-400 dark:text-green-300">
            {activeCount} ✅ نشط
          </Badge>
        )}
        {hasChecked && inactiveCount > 0 && (
          <Badge variant="outline" className="text-xs text-red-700 border-red-400 dark:text-red-300">
            {inactiveCount} ❌ منتهي
          </Badge>
        )}
      </div>
      <div className="rounded-md border border-border bg-muted/40 max-h-52 overflow-y-auto p-2 space-y-0.5">
        {links.map((link, i) => {
          const url = extractUrlFromEntry(link);
          const cr = getCheckResult(url, checkResults);
          return (
            <LinkEntry key={i} entry={link} colorClass={colorClass} checkResult={cr} />
          );
        })}
      </div>
    </div>
  );
}

export default function Home() {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [whatsappLimit, setWhatsappLimit] = useState(40);
  const [checkState, setCheckState] = useState<CheckState | null>(null);
  const [hasUnknown, setHasUnknown] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const processMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("whatsappLimit", String(whatsappLimit));
      const res = await fetch("/api/process", { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "فشل المعالجة" }));
        throw new Error(err.message || "فشل المعالجة");
      }
      return res.json() as Promise<ProcessResult>;
    },
    onSuccess: (data) => {
      setResult(data);
      setCheckState(null);
      toast({ title: "تمت المعالجة بنجاح", description: `تم استخراج ${data.stats.totalTg + data.stats.totalWa} رابط فريد` });
    },
    onError: (err: Error) => {
      toast({ title: "خطأ", description: err.message, variant: "destructive" });
    },
  });

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/check-links/status");
        if (!res.ok) return;
        const data = await res.json() as CheckState & { error: string };

        setCheckState({
          running: data.running,
          checked: data.checked,
          total: data.total,
          totalActive: data.totalActive,
          totalInactive: data.totalInactive ?? 0,
          totalUnknown: data.totalUnknown ?? 0,
          results: data.results ?? {},
        });

        if (!data.running) {
          stopPolling();
          if ((data.totalUnknown ?? 0) > 0) setHasUnknown(true);
          if (data.error) {
            toast({ title: "خطأ في الفحص", description: data.error, variant: "destructive" });
          }
        }
      } catch { /* network error, keep polling */ }
    }, 1000);
  }, [stopPolling, toast]);

  const estimateMinutes = useCallback((total: number) => {
    // ~8 seconds per WhatsApp link + ~1 second per Telegram link
    // rough estimate: treat all as WhatsApp-speed to be safe
    const secs = total * 8;
    const mins = Math.ceil(secs / 60);
    return mins;
  }, []);

  const handleCheckLinks = useCallback(async () => {
    if (!result) return;
    try {
      setHasUnknown(false);
      const res = await fetch("/api/check-links/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "فشل بدء الفحص");
      setCheckState({ running: true, checked: 0, total: data.total, totalActive: 0, totalInactive: 0, totalUnknown: 0, results: {} });
      startPolling();
    } catch (err: any) {
      toast({ title: "خطأ في الفحص", description: err.message, variant: "destructive" });
    }
  }, [result, startPolling, toast]);

  const handleCancelCheck = useCallback(async () => {
    stopPolling();
    await fetch("/api/check-links/cancel", { method: "POST" }).catch(() => {});
    setCheckState((prev) => prev ? { ...prev, running: false } : null);
  }, [stopPolling]);

  const downloadMutation = useMutation({
    mutationFn: async ({ type, activeOnly }: { type: "tg" | "wa"; activeOnly: boolean }) => {
      const url = `/api/download/${type}${activeOnly ? "?activeOnly=1" : ""}`;
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error("فشل تحميل الملف");
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      const platform = type === "tg" ? "Telegram" : "WhatsApp";
      a.download = activeOnly ? `${platform}_Links_Active.docx` : `${platform}_Links_Filtered.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    },
    onError: () => {
      toast({ title: "خطأ", description: "فشل تحميل الملف", variant: "destructive" });
    },
  });

  const handleFile = useCallback(
    (file: File) => {
      if (!file.name.endsWith(".docx")) {
        toast({ title: "نوع ملف غير صالح", description: "يرجى رفع ملف .docx فقط", variant: "destructive" });
        return;
      }
      setSelectedFile(file);
      setResult(null);
      setCheckState(null);
    },
    [toast]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const reset = () => {
    stopPolling();
    fetch("/api/check-links/cancel", { method: "POST" }).catch(() => {});
    setSelectedFile(null);
    setResult(null);
    setCheckState(null);
    setHasUnknown(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const totalLinks = result ? result.stats.totalTg + result.stats.totalWa : 0;
  const checksAvailable = checkState && !checkState.running && Object.keys(checkState.results).length > 0;

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      <header className="border-b border-border bg-card shadow-sm">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-primary flex items-center justify-center">
            <FileText className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">مُصفّي الروابط</h1>
            <p className="text-xs text-muted-foreground leading-tight">واتساب وتيليجرام</p>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">

        <Card className="border-card-border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">رفع الملف</CardTitle>
            <CardDescription className="text-sm">
              ارفع ملف <span className="font-mono bg-muted px-1 rounded-sm text-xs">.docx</span> يحتوي على الروابط لاستخراجها وتصفيتها
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              className={`border-2 border-dashed rounded-md p-8 text-center cursor-pointer transition-all ${
                dragOver ? "border-primary bg-primary/5"
                : selectedFile ? "border-primary/50 bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-muted/50"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".docx"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
              {selectedFile ? (
                <div className="flex flex-col items-center gap-2">
                  <CheckCircle className="w-10 h-10 text-primary" />
                  <p className="font-semibold text-sm">{selectedFile.name}</p>
                  <p className="text-xs text-muted-foreground">{(selectedFile.size / 1024).toFixed(1)} كيلوبايت</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Upload className="w-10 h-10 text-muted-foreground" />
                  <div>
                    <p className="font-semibold text-sm">اسحب الملف هنا أو انقر للرفع</p>
                    <p className="text-xs text-muted-foreground mt-1">يدعم ملفات .docx فقط</p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground whitespace-nowrap">حد الواتساب لكل رسالة:</label>
              <input
                type="number"
                min={1}
                max={200}
                value={whatsappLimit}
                onChange={(e) => setWhatsappLimit(Number(e.target.value))}
                className="w-20 border border-input rounded-md px-3 py-1.5 text-sm bg-background text-center focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="text-xs text-muted-foreground">رابط</span>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                onClick={() => selectedFile && processMutation.mutate(selectedFile)}
                disabled={!selectedFile || processMutation.isPending}
                className="gap-2"
              >
                {processMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                {processMutation.isPending ? "جاري المعالجة..." : "معالجة الروابط"}
              </Button>
              {selectedFile && (
                <Button variant="outline" onClick={reset} className="gap-2">
                  <RefreshCw className="w-4 h-4" />
                  إعادة تعيين
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {result && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="روابط تيليجرام" value={result.stats.totalTg} color="bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200" />
              <StatCard label="روابط واتساب" value={result.stats.totalWa} color="bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-200" />
              <StatCard label="إجمالي الروابط" value={totalLinks} color="bg-purple-50 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200" />
              <StatCard label="مكررة أُزيلت" value={result.stats.duplicatesRemoved} color="bg-orange-50 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200" />
            </div>

            <Card className="border-card-border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-primary" />
                  فحص الروابط
                </CardTitle>
                <CardDescription className="text-sm">
                  يتحقق من كل رابط عبر الإنترنت ويكشف النشطة من المنتهية الصلاحية — دون الانضمام لأي مجموعة
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {checkState && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>
                        {checkState.running
                          ? `جاري الفحص... ${checkState.checked} / ${checkState.total}`
                          : `اكتمل الفحص — ${checkState.checked} رابط`}
                      </span>
                      {!checkState.running && (
                        <span className="text-green-700 dark:text-green-400 font-semibold">
                          {checkState.totalActive} نشط
                        </span>
                      )}
                    </div>
                    <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          checkState.running ? "bg-primary animate-pulse" : "bg-green-500"
                        }`}
                        style={{ width: `${checkState.total > 0 ? (checkState.checked / checkState.total) * 100 : 0}%` }}
                      />
                    </div>
                    {checkState.running && (
                      <p className="text-xs text-muted-foreground">
                        يفحص رابطاً واحداً كل ~٨ ثوانٍ تجنباً لحجب واتساب. المتبقي: ~{estimateMinutes(checkState.total - checkState.checked)} دقيقة — يرجى الانتظار ولا تغلق الصفحة
                      </p>
                    )}
                  </div>
                )}

                {checksAvailable && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {checkState!.totalActive > 0 && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 text-sm">
                          <Wifi className="w-4 h-4" />
                          <span>{checkState!.totalActive} نشط ✅</span>
                        </div>
                      )}
                      {checkState!.totalInactive > 0 && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 text-sm">
                          <WifiOff className="w-4 h-4" />
                          <span>{checkState!.totalInactive} منتهي ❌</span>
                        </div>
                      )}
                      {checkState!.totalUnknown > 0 && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200 text-sm">
                          <AlertCircle className="w-4 h-4" />
                          <span>{checkState!.totalUnknown} غير محدد ⚠️</span>
                        </div>
                      )}
                    </div>
                    {hasUnknown && (
                      <div className="flex gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-xs text-amber-800 dark:text-amber-200">
                        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        <div className="space-y-1">
                          <p className="font-semibold">بعض الروابط لم يمكن التحقق منها</p>
                          <p>واتساب وتيليجرام يحجبان طلبات الفحص التلقائي من الخوادم السحابية — الروابط ذات علامة ⚠️ تُدرج في ملف "النشطة" تحاشياً لحذف روابط صالحة. للتحقق اليدوي افتح الرابط مباشرة من هاتفك.</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-2 flex-wrap">
                  <Button
                    onClick={handleCheckLinks}
                    disabled={checkState?.running}
                    variant={checksAvailable ? "outline" : "default"}
                    className="gap-2"
                  >
                    {checkState?.running
                      ? <Loader2 className="w-4 h-4 animate-spin" />
                      : <ShieldCheck className="w-4 h-4" />}
                    {checkState?.running ? "جاري الفحص..."
                      : checksAvailable ? "إعادة الفحص"
                      : "فحص الروابط الآن"}
                  </Button>
                  {checkState?.running && (
                    <Button
                      onClick={handleCancelCheck}
                      variant="outline"
                      className="gap-2 text-destructive border-destructive/40 hover:bg-destructive/10"
                    >
                      <XCircle className="w-4 h-4" />
                      إلغاء الفحص
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="border-card-border shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-semibold">تحميل النتائج</CardTitle>
                <CardDescription className="text-sm">
                  {checksAvailable ? "حمّل جميع الروابط، أو النشطة فقط بعد الفحص" : "حمّل ملفات Word المعالجة مرتبة ومصنّفة"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    onClick={() => downloadMutation.mutate({ type: "tg", activeOnly: false })}
                    disabled={downloadMutation.isPending || result.stats.totalTg === 0}
                    className="flex items-center gap-3 p-3 rounded-md border border-blue-200 bg-blue-50 hover:bg-blue-100 cursor-pointer text-right disabled:opacity-50 disabled:cursor-not-allowed dark:border-blue-700 dark:bg-blue-900/20 flex-1"
                  >
                    <div className="w-9 h-9 rounded-md bg-blue-500 flex items-center justify-center flex-shrink-0">
                      <Send className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold text-sm text-blue-900 dark:text-blue-100">تيليجرام — الكل</p>
                      <p className="text-xs text-blue-700 dark:text-blue-300">{result.stats.totalTg} رابط</p>
                    </div>
                    <Download className="w-4 h-4 text-blue-600 dark:text-blue-300 flex-shrink-0" />
                  </button>
                  {checksAvailable && (
                    <button
                      onClick={() => downloadMutation.mutate({ type: "tg", activeOnly: true })}
                      disabled={downloadMutation.isPending || result.stats.totalTg === 0}
                      className="flex items-center gap-3 p-3 rounded-md border border-green-300 bg-green-50 hover:bg-green-100 cursor-pointer text-right disabled:opacity-50 disabled:cursor-not-allowed dark:border-green-700 dark:bg-green-900/20 flex-1"
                    >
                      <div className="w-9 h-9 rounded-md bg-green-500 flex items-center justify-center flex-shrink-0">
                        <Wifi className="w-4 h-4 text-white" />
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold text-sm text-green-900 dark:text-green-100">تيليجرام — نشطة فقط</p>
                        <p className="text-xs text-green-700 dark:text-green-300">النشطة بعد الفحص</p>
                      </div>
                      <Download className="w-4 h-4 text-green-600 dark:text-green-300 flex-shrink-0" />
                    </button>
                  )}
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    onClick={() => downloadMutation.mutate({ type: "wa", activeOnly: false })}
                    disabled={downloadMutation.isPending || result.stats.totalWa === 0}
                    className="flex items-center gap-3 p-3 rounded-md border border-green-200 bg-green-50 hover:bg-green-100 cursor-pointer text-right disabled:opacity-50 disabled:cursor-not-allowed dark:border-green-700 dark:bg-green-900/20 flex-1"
                  >
                    <div className="w-9 h-9 rounded-md bg-green-500 flex items-center justify-center flex-shrink-0">
                      <MessageCircle className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold text-sm text-green-900 dark:text-green-100">واتساب — الكل</p>
                      <p className="text-xs text-green-700 dark:text-green-300">{result.stats.totalWa} رابط</p>
                    </div>
                    <Download className="w-4 h-4 text-green-600 dark:text-green-300 flex-shrink-0" />
                  </button>
                  {checksAvailable && (
                    <button
                      onClick={() => downloadMutation.mutate({ type: "wa", activeOnly: true })}
                      disabled={downloadMutation.isPending || result.stats.totalWa === 0}
                      className="flex items-center gap-3 p-3 rounded-md border border-teal-300 bg-teal-50 hover:bg-teal-100 cursor-pointer text-right disabled:opacity-50 disabled:cursor-not-allowed dark:border-teal-700 dark:bg-teal-900/20 flex-1"
                    >
                      <div className="w-9 h-9 rounded-md bg-teal-500 flex items-center justify-center flex-shrink-0">
                        <Wifi className="w-4 h-4 text-white" />
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold text-sm text-teal-900 dark:text-teal-100">واتساب — نشطة فقط</p>
                        <p className="text-xs text-teal-700 dark:text-teal-300">النشطة بعد الفحص</p>
                      </div>
                      <Download className="w-4 h-4 text-teal-600 dark:text-teal-300 flex-shrink-0" />
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="grid sm:grid-cols-2 gap-4">
              <Card className="border-card-border shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-md bg-blue-500 flex items-center justify-center">
                      <Send className="w-3.5 h-3.5 text-white" />
                    </div>
                    <CardTitle className="text-sm font-semibold">تيليجرام</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <LinkSection title="خاص فاميلي" links={result.tg.family} icon={<span className="text-xs">👪</span>} colorClass="bg-blue-50 text-blue-900 dark:bg-blue-900/20 dark:text-blue-100" checkResults={checkState?.results ?? {}} />
                  <LinkSection title="من مفيد" links={result.tg.mofeed} icon={<span className="text-xs">📢</span>} colorClass="bg-slate-50 text-slate-800 dark:bg-slate-800/40 dark:text-slate-200" checkResults={checkState?.results ?? {}} />
                  {result.tg.family.length === 0 && result.tg.mofeed.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">لا توجد روابط تيليجرام</p>
                  )}
                </CardContent>
              </Card>
              <Card className="border-card-border shadow-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-md bg-green-500 flex items-center justify-center">
                      <MessageCircle className="w-3.5 h-3.5 text-white" />
                    </div>
                    <CardTitle className="text-sm font-semibold">واتساب</CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <LinkSection title="خاص فاميلي" links={result.wa.family} icon={<span className="text-xs">👪</span>} colorClass="bg-green-50 text-green-900 dark:bg-green-900/20 dark:text-green-100" checkResults={checkState?.results ?? {}} />
                  <LinkSection title="من مفيد" links={result.wa.mofeed} icon={<span className="text-xs">📢</span>} colorClass="bg-slate-50 text-slate-800 dark:bg-slate-800/40 dark:text-slate-200" checkResults={checkState?.results ?? {}} />
                  {result.wa.family.length === 0 && result.wa.mofeed.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">لا توجد روابط واتساب</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}

        {!result && (
          <Card className="border-card-border shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-semibold">كيف يعمل التطبيق؟</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid sm:grid-cols-4 gap-4">
                {[
                  { step: "١", title: "رفع الملف", desc: "ارفع ملف Word يحتوي على الروابط المختلطة", color: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200" },
                  { step: "٢", title: "المعالجة", desc: "يُصنّف الروابط تلقائيًا ويُزيل المكررات", color: "bg-primary/10 text-primary" },
                  { step: "٣", title: "فحص النشاط", desc: "يتحقق من كل رابط دون الانضمام للمجموعات", color: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200" },
                  { step: "٤", title: "التحميل", desc: "حمّل الكل أو النشطة فقط بصيغة Word", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200" },
                ].map((item) => (
                  <div key={item.step} className="flex flex-col gap-2 p-4 rounded-md border border-border">
                    <div className={`w-8 h-8 rounded-md flex items-center justify-center font-bold text-sm ${item.color}`}>{item.step}</div>
                    <p className="font-semibold text-sm">{item.title}</p>
                    <p className="text-xs text-muted-foreground">{item.desc}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 p-3 rounded-md bg-muted/60 text-xs text-muted-foreground space-y-1">
                <p className="font-semibold text-foreground text-sm mb-2">التصنيف التلقائي:</p>
                <p>• روابط تحتوي على كلمة <strong>فاميلي</strong> أو <strong>فاملي</strong> → قسم خاص فاميلي</p>
                <p>• باقي الروابط → قسم من مفيد</p>
                <p>• روابط <strong>t.me</strong> → ملف تيليجرام</p>
                <p>• روابط <strong>chat.whatsapp.com</strong> → ملف واتساب</p>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
