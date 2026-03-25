import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Upload, FileText, Download, CheckCircle2, XCircle, AlertCircle,
  Loader2, Wifi, WifiOff, Smartphone, LogOut, RefreshCw, Shield,
  Link2, ChevronRight, QrCode, Hash, ArrowRight,
} from "lucide-react";
import { SiWhatsapp, SiTelegram } from "react-icons/si";

type WAStatus = "disconnected" | "connecting" | "qr_ready" | "pairing" | "connected" | "auth_failed";
type Step = "upload" | "links" | "connect" | "checking" | "results";

interface CheckResult {
  link: string;
  status: "pending" | "valid" | "invalid" | "error";
  info?: string;
  name?: string;
  members?: number;
}
interface CheckSession {
  id: string;
  links: string[];
  results: CheckResult[];
  progress: number;
  total: number;
  status: "idle" | "running" | "done" | "error";
  startedAt: string;
  completedAt?: string;
}
interface WAStatusRes {
  status: WAStatus;
  qrCode: string | null;
  pairingCode: string | null;
  session: CheckSession | null;
}

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "رفع الملف" },
  { key: "links", label: "الروابط" },
  { key: "connect", label: "ربط واتساب" },
  { key: "checking", label: "الفحص" },
  { key: "results", label: "النتائج" },
];

export default function Home() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("upload");
  const [linkCounts, setLinkCounts] = useState({ whatsapp: 0, telegram: 0 });
  const [connectMode, setConnectMode] = useState<"qr" | "pair">("qr");
  const [phone, setPhone] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: waData, refetch: refetchWA } = useQuery<WAStatusRes>({
    queryKey: ["/api/whatsapp/status"],
    refetchInterval: step === "connect" || step === "checking" ? 2000 : false,
  });

  const { data: progressData } = useQuery<{ session: CheckSession | null }>({
    queryKey: ["/api/whatsapp/progress"],
    refetchInterval: step === "checking" ? 1000 : false,
  });

  const waStatus = waData?.status ?? "disconnected";
  const qrCode = waData?.qrCode ?? null;
  const pairingCode = waData?.pairingCode ?? null;
  const session = progressData?.session ?? waData?.session ?? null;

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "خطأ في الرفع");
      return data;
    },
    onSuccess: (data) => {
      setLinkCounts({ whatsapp: data.whatsapp, telegram: data.telegram });
      setStep("links");
      toast({ title: "تم استخراج الروابط بنجاح" });
    },
    onError: (err: any) => {
      toast({ title: "خطأ", description: err.message, variant: "destructive" });
    },
  });

  const connectQRMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/connect", {}),
    onSuccess: () => {
      setStep("connect");
      setConnectMode("qr");
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] });
    },
    onError: (err: any) => {
      toast({ title: "خطأ في الاتصال", description: err.message, variant: "destructive" });
    },
  });

  const connectPairMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/pair", { phone }),
    onSuccess: () => {
      setStep("connect");
      setConnectMode("pair");
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] });
    },
    onError: (err: any) => {
      toast({ title: "خطأ", description: err.message, variant: "destructive" });
    },
  });

  const resendPairMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/pair/resend", { phone }),
    onSuccess: async () => {
      toast({ title: "تم إعادة الإرسال", description: "تم إرسال رمز ربط جديد" });
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] });
    },
    onError: (err: any) => {
      toast({ title: "فشل الإرسال", description: err.message, variant: "destructive" });
    },
  });

  const checkMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/check", {}),
    onSuccess: () => {
      setStep("checking");
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/progress"] });
    },
    onError: (err: any) => {
      toast({ title: "خطأ", description: err.message, variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/disconnect", {}),
    onSuccess: () => {
      setStep("links");
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] });
    },
  });

  // Auto-start checking as soon as WhatsApp is confirmed connected
  useEffect(() => {
    if (waStatus === "connected" && step === "connect") {
      setStep("checking");
      checkMutation.mutate();
    }
  }, [waStatus, step]);

  // Auto-advance to results when checking finishes
  useEffect(() => {
    if (session?.status === "done" && step === "checking") {
      setStep("results");
    }
  }, [session?.status, step]);

  const handleFile = useCallback((file: File) => {
    if (!file.name.match(/\.docx?$/i)) {
      toast({ title: "خطأ", description: "يجب أن يكون الملف بصيغة DOCX", variant: "destructive" });
      return;
    }
    uploadMutation.mutate(file);
  }, [uploadMutation, toast]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const progressPct = session ? Math.round((session.progress / session.total) * 100) : 0;
  const validResults = session?.results.filter((r) => r.status === "valid") ?? [];
  const invalidResults = session?.results.filter((r) => r.status === "invalid") ?? [];
  const errorResults = session?.results.filter((r) => r.status === "error") ?? [];

  const currentStepIdx = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-card/90 backdrop-blur-md">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
              <SiWhatsapp className="w-4 h-4 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-sm font-bold leading-none">Link Checker Pro</h1>
              <p className="text-xs text-muted-foreground leading-none mt-0.5">فاحص روابط واتساب وتيليغرام</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill status={waStatus} />
            {(waStatus === "connected" || waStatus === "qr_ready" || waStatus === "pairing") && (
              <Button size="sm" variant="outline" onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending} data-testid="button-disconnect">
                <LogOut className="w-3.5 h-3.5 ml-1" />
                <span className="text-xs">قطع</span>
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Steps */}
        <div className="flex items-center justify-between mb-8 overflow-x-auto pb-1">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-1 flex-shrink-0">
              <div className="flex flex-col items-center gap-1">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                  i < currentStepIdx ? "bg-primary text-primary-foreground" :
                  i === currentStepIdx ? "bg-primary text-primary-foreground ring-4 ring-primary/20" :
                  "bg-muted text-muted-foreground"
                }`} data-testid={`step-${s.key}`}>
                  {i < currentStepIdx ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                </div>
                <span className={`text-xs whitespace-nowrap ${
                  i === currentStepIdx ? "text-primary font-medium" :
                  i < currentStepIdx ? "text-foreground" : "text-muted-foreground"
                }`}>{s.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`w-8 sm:w-12 h-0.5 mx-1 mb-4 rounded ${i < currentStepIdx ? "bg-primary" : "bg-border"}`} />
              )}
            </div>
          ))}
        </div>

        {/* ── Step: Upload ── */}
        {step === "upload" && (
          <div className="space-y-4">
            <Card className="border-2 border-dashed transition-colors"
              style={{ borderColor: isDragging ? "hsl(var(--primary))" : undefined }}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}>
              <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
                {uploadMutation.isPending ? (
                  <>
                    <Loader2 className="w-12 h-12 text-primary animate-spin" />
                    <p className="text-muted-foreground">جاري استخراج الروابط...</p>
                  </>
                ) : (
                  <>
                    <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors ${
                      isDragging ? "bg-primary text-primary-foreground" : "bg-muted"
                    }`}>
                      <Upload className={`w-8 h-8 ${isDragging ? "text-primary-foreground" : "text-muted-foreground"}`} />
                    </div>
                    <div className="text-center">
                      <p className="font-semibold text-foreground">اسحب وأفلت ملف DOCX هنا</p>
                      <p className="text-sm text-muted-foreground mt-1">أو اضغط لاختيار الملف</p>
                    </div>
                    <Button variant="outline" onClick={() => fileRef.current?.click()}
                      data-testid="button-browse-file">
                      <FileText className="w-4 h-4 ml-2" />
                      اختيار ملف DOCX
                    </Button>
                    <input ref={fileRef} type="file" accept=".docx,.doc" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                      data-testid="input-file" />
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <h3 className="text-sm font-semibold mb-2">ما الذي يمكنني رفعه؟</h3>
                <div className="grid sm:grid-cols-2 gap-3 text-sm text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <SiWhatsapp className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                    <span>روابط مجموعات واتساب <code className="text-xs bg-muted px-1 rounded">chat.whatsapp.com/...</code></span>
                  </div>
                  <div className="flex items-start gap-2">
                    <SiWhatsapp className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                    <span>روابط أرقام واتساب <code className="text-xs bg-muted px-1 rounded">wa.me/...</code></span>
                  </div>
                  <div className="flex items-start gap-2">
                    <SiTelegram className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" />
                    <span>روابط تيليغرام <code className="text-xs bg-muted px-1 rounded">t.me/...</code></span>
                  </div>
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <span>يزيل الروابط المكررة تلقائياً</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Step: Links preview ── */}
        {step === "links" && (
          <div className="space-y-5">
            <div className="grid sm:grid-cols-2 gap-4">
              {/* WhatsApp card */}
              <Card>
                <CardContent className="pt-5">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <SiWhatsapp className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-bold text-2xl leading-none">{linkCounts.whatsapp}</p>
                      <p className="text-sm text-muted-foreground">رابط واتساب</p>
                    </div>
                  </div>
                  <Button className="w-full" variant="outline"
                    onClick={() => window.open("/api/download/whatsapp", "_blank")}
                    disabled={linkCounts.whatsapp === 0}
                    data-testid="button-download-whatsapp">
                    <Download className="w-4 h-4 ml-2" />
                    تحميل روابط واتساب (.docx)
                  </Button>
                </CardContent>
              </Card>

              {/* Telegram card */}
              <Card>
                <CardContent className="pt-5">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center">
                      <SiTelegram className="w-5 h-5 text-blue-500" />
                    </div>
                    <div>
                      <p className="font-bold text-2xl leading-none">{linkCounts.telegram}</p>
                      <p className="text-sm text-muted-foreground">رابط تيليغرام</p>
                    </div>
                  </div>
                  <Button className="w-full" variant="outline"
                    onClick={() => window.open("/api/download/telegram", "_blank")}
                    disabled={linkCounts.telegram === 0}
                    data-testid="button-download-telegram">
                    <Download className="w-4 h-4 ml-2" />
                    تحميل روابط تيليغرام (.docx)
                  </Button>
                </CardContent>
              </Card>
            </div>

            {/* Check links section */}
            {linkCounts.whatsapp > 0 && (
              <Card className="border-primary/30 bg-primary/5">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="w-5 h-5 text-primary" />
                    فحص روابط واتساب
                  </CardTitle>
                  <CardDescription>
                    ستحتاج إلى ربط حساب واتساب للتحقق من الروابط النشطة. يتم الفحص مع تأخير عشوائي للحماية من الحظر.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-3">
                    {/* QR mode */}
                    <div className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                      connectMode === "qr" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                    }`} onClick={() => setConnectMode("qr")} data-testid="select-qr-mode">
                      <div className="flex items-center gap-2 mb-1">
                        <QrCode className="w-4 h-4 text-primary" />
                        <span className="text-sm font-medium">رمز QR</span>
                      </div>
                      <p className="text-xs text-muted-foreground">امسح الرمز من تطبيق واتساب</p>
                    </div>
                    {/* Pairing mode */}
                    <div className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                      connectMode === "pair" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
                    }`} onClick={() => setConnectMode("pair")} data-testid="select-pair-mode">
                      <div className="flex items-center gap-2 mb-1">
                        <Hash className="w-4 h-4 text-primary" />
                        <span className="text-sm font-medium">رمز الربط</span>
                      </div>
                      <p className="text-xs text-muted-foreground">أدخل رقم هاتفك للحصول على رمز</p>
                    </div>
                  </div>

                  {connectMode === "pair" && (
                    <div className="flex gap-2">
                      <Input value={phone} onChange={(e) => setPhone(e.target.value)}
                        placeholder="966512345678 (بدون +)"
                        className="flex-1 font-mono text-sm" dir="ltr"
                        data-testid="input-phone" />
                    </div>
                  )}

                  <Button className="w-full" size="lg"
                    onClick={() => connectMode === "qr" ? connectQRMutation.mutate() : connectPairMutation.mutate()}
                    disabled={connectQRMutation.isPending || connectPairMutation.isPending || (connectMode === "pair" && !phone.trim())}
                    data-testid="button-check-links">
                    {(connectQRMutation.isPending || connectPairMutation.isPending) ? (
                      <Loader2 className="w-4 h-4 ml-2 animate-spin" />
                    ) : (
                      <SiWhatsapp className="w-4 h-4 ml-2" />
                    )}
                    فحص الروابط
                  </Button>
                </CardContent>
              </Card>
            )}

            <Button variant="ghost" size="sm" onClick={() => setStep("upload")}
              data-testid="button-reupload">
              <ArrowRight className="w-4 h-4 ml-1" />
              رفع ملف آخر
            </Button>
          </div>
        )}

        {/* ── Step: Connect ── */}
        {step === "connect" && (
          <div className="space-y-4 max-w-md mx-auto">
            <Card>
              <CardHeader className="pb-2 text-center">
                <CardTitle className="flex items-center justify-center gap-2">
                  <SiWhatsapp className="w-5 h-5 text-primary" />
                  {connectMode === "qr" ? "امسح رمز QR" : "أدخل رمز الربط"}
                </CardTitle>
                <CardDescription>
                  {connectMode === "qr"
                    ? "افتح واتساب → الأجهزة المرتبطة → ربط جهاز → امسح الرمز"
                    : "افتح واتساب → الأجهزة المرتبطة → ربط بالرقم → أدخل الرمز"}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-4">
                {/* Status indicator */}
                <WAStatusCard status={waStatus} />

                {/* QR Code */}
                {connectMode === "qr" && (
                  <>
                    {qrCode ? (
                      <div className="p-3 bg-white rounded-xl shadow border">
                        <img src={qrCode} alt="QR Code" className="w-56 h-56" data-testid="img-qr-code" />
                      </div>
                    ) : waStatus === "connecting" || waStatus === "qr_ready" ? (
                      <div className="w-56 h-56 bg-muted rounded-xl flex items-center justify-center">
                        <Loader2 className="w-10 h-10 text-primary animate-spin" />
                      </div>
                    ) : null}
                  </>
                )}

                {/* Pairing Code */}
                {connectMode === "pair" && (
                  <>
                    {pairingCode ? (
                      <div className="flex flex-col items-center gap-3 w-full">
                        <p className="text-xs text-muted-foreground">أدخل هذا الرمز في واتساب</p>
                        <div className="text-4xl font-mono font-bold tracking-widest bg-muted px-6 py-4 rounded-xl border w-full text-center"
                          data-testid="text-pairing-code">
                          {pairingCode}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => resendPairMutation.mutate()}
                          disabled={resendPairMutation.isPending}
                          data-testid="button-resend-pair">
                          {resendPairMutation.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5 ml-1" />
                          )}
                          إعادة إرسال الرمز
                        </Button>
                        <p className="text-xs text-muted-foreground text-center">
                          لم يصلك الرمز أو انتهت صلاحيته؟ اضغط إعادة الإرسال
                        </p>
                      </div>
                    ) : waStatus === "pairing" || waStatus === "connecting" ? (
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-8 h-8 text-primary animate-spin" />
                        <p className="text-sm text-muted-foreground">جاري الحصول على رمز الربط...</p>
                      </div>
                    ) : null}
                  </>
                )}

                {waStatus === "connected" && (
                  <div className="flex flex-col items-center gap-2">
                    <CheckCircle2 className="w-12 h-12 text-primary" />
                    <p className="font-semibold text-primary">تم الاتصال بنجاح!</p>
                    <p className="text-sm text-muted-foreground">جاري بدء فحص الروابط...</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Button variant="outline" className="w-full" onClick={() => { disconnectMutation.mutate(); setStep("links"); }}
              data-testid="button-cancel-connect">
              <ArrowRight className="w-4 h-4 ml-1" />
              رجوع
            </Button>
          </div>
        )}

        {/* ── Step: Checking — loading state while session initialises ── */}
        {step === "checking" && !session && (
          <div className="flex flex-col items-center justify-center gap-4 py-20">
            <Loader2 className="w-12 h-12 text-primary animate-spin" />
            <p className="text-muted-foreground">جاري بدء الفحص...</p>
          </div>
        )}

        {/* ── Step: Checking ── */}
        {step === "checking" && session && (
          <div className="space-y-5">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {session.status === "running" ? (
                      <Loader2 className="w-5 h-5 text-primary animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-5 h-5 text-primary" />
                    )}
                    {session.status === "running" ? "جاري فحص الروابط..." : "اكتمل الفحص"}
                  </CardTitle>
                  <Badge variant="outline">{session.progress} / {session.total}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">التقدم</span>
                    <span className="font-medium">{progressPct}%</span>
                  </div>
                  <Progress value={progressPct} className="h-2" />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <StatBox color="green" icon={<CheckCircle2 className="w-4 h-4" />}
                    label="صالحة" value={validResults.length} />
                  <StatBox color="red" icon={<XCircle className="w-4 h-4" />}
                    label="منتهية" value={invalidResults.length} />
                  <StatBox color="orange" icon={<AlertCircle className="w-4 h-4" />}
                    label="خطأ" value={errorResults.length} />
                </div>
              </CardContent>
            </Card>

            {/* Live feed */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">آخر النتائج</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                  {session.results
                    .filter((r) => r.status !== "pending")
                    .slice(-20)
                    .reverse()
                    .map((r, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs py-1 border-b border-border/50 last:border-0">
                        {r.status === "valid" && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />}
                        {r.status === "invalid" && <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                        {r.status === "error" && <AlertCircle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />}
                        <span className="font-mono truncate text-muted-foreground flex-1">{r.link}</span>
                        <span className={`flex-shrink-0 text-right ${
                          r.status === "valid" ? "text-green-600" :
                          r.status === "invalid" ? "text-red-600" : "text-orange-600"
                        }`}>
                          {r.name ? `${r.name}${r.members !== undefined ? ` ${r.members} عضو` : ""}` : (r.info ?? r.status)}
                        </span>
                      </div>
                    ))}
                  {session.results.filter((r) => r.status !== "pending").length === 0 && (
                    <p className="text-center text-muted-foreground py-4 text-sm">في انتظار النتائج...</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="p-3 bg-muted rounded-lg flex items-start gap-2 text-xs text-muted-foreground">
              <Shield className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
              <span>يُستخدم تأخير عشوائي بين 0.5 و1.2 ثانية بين كل رابط للحماية من الحظر التلقائي</span>
            </div>
          </div>
        )}

        {/* ── Step: Results ── */}
        {step === "results" && session && (
          <div className="space-y-5">
            <div className="grid grid-cols-3 gap-4">
              <StatBox color="green" icon={<CheckCircle2 className="w-5 h-5" />}
                label="روابط صالحة" value={validResults.length} large />
              <StatBox color="red" icon={<XCircle className="w-5 h-5" />}
                label="منتهية" value={invalidResults.length} large />
              <StatBox color="orange" icon={<AlertCircle className="w-5 h-5" />}
                label="أخطاء" value={errorResults.length} large />
            </div>

            {validResults.length > 0 ? (
              <Card className="border-primary/30 bg-primary/5">
                <CardContent className="pt-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-primary" />
                    <p className="font-semibold">تم العثور على {validResults.length} رابط صالح</p>
                  </div>
                  <Button className="w-full" size="lg"
                    onClick={() => window.open("/api/whatsapp/download-valid", "_blank")}
                    data-testid="button-download-valid">
                    <Download className="w-4 h-4 ml-2" />
                    تحميل الروابط الصالحة (.docx)
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="pt-5 text-center text-muted-foreground">
                  <XCircle className="w-10 h-10 mx-auto mb-2 text-muted-foreground/50" />
                  <p>لم يتم العثور على روابط صالحة</p>
                </CardContent>
              </Card>
            )}

            {/* Full results list */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">جميع النتائج ({session.total})</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1 max-h-72 overflow-y-auto">
                  {session.results.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0">
                      {r.status === "valid" && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />}
                      {r.status === "invalid" && <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                      {r.status === "error" && <AlertCircle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />}
                      {r.status === "pending" && <Loader2 className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 animate-spin" />}
                      <div className="flex-1 min-w-0">
                        <span className="font-mono text-xs truncate block text-muted-foreground">{r.link}</span>
                        {r.name && (
                          <span className="text-xs text-foreground font-medium">
                            {r.name}{r.members !== undefined ? ` — ${r.members} عضو` : ""}
                          </span>
                        )}
                      </div>
                      <Badge variant={r.status === "valid" ? "default" : "secondary"}
                        className="text-xs flex-shrink-0">
                        {r.status === "valid" ? "صالح" : r.status === "invalid" ? "منتهٍ" : "خطأ"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => {
                setStep("links");
                disconnectMutation.mutate();
              }} data-testid="button-new-check">
                <RefreshCw className="w-4 h-4 ml-2" />
                فحص جديد
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => setStep("upload")}
                data-testid="button-upload-new">
                <Upload className="w-4 h-4 ml-2" />
                رفع ملف جديد
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/* ── Sub-components ── */

function StatusPill({ status }: { status: WAStatus }) {
  const map: Record<WAStatus, { label: string; cls: string; icon: JSX.Element }> = {
    disconnected: { label: "غير متصل", cls: "bg-muted text-muted-foreground", icon: <WifiOff className="w-3 h-3" /> },
    connecting: { label: "جاري الاتصال", cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400", icon: <Loader2 className="w-3 h-3 animate-spin" /> },
    qr_ready: { label: "في انتظار المسح", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400", icon: <QrCode className="w-3 h-3" /> },
    pairing: { label: "في انتظار الرمز", cls: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400", icon: <Hash className="w-3 h-3" /> },
    connected: { label: "متصل", cls: "bg-primary/10 text-primary", icon: <Wifi className="w-3 h-3" /> },
    auth_failed: { label: "فشل الاتصال", cls: "bg-destructive/10 text-destructive", icon: <WifiOff className="w-3 h-3" /> },
  };
  const c = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${c.cls}`}
      data-testid="status-pill">
      {c.icon}{c.label}
    </span>
  );
}

function WAStatusCard({ status }: { status: WAStatus }) {
  const configs: Partial<Record<WAStatus, { label: string; desc: string; color: string }>> = {
    connecting: { label: "جاري الاتصال...", desc: "يتم إنشاء الاتصال مع واتساب", color: "text-yellow-600" },
    qr_ready: { label: "جاهز للمسح", desc: "امسح الرمز بتطبيق واتساب", color: "text-blue-600" },
    pairing: { label: "في انتظار الرمز", desc: "جاري الحصول على رمز الربط", color: "text-purple-600" },
    connected: { label: "متصل!", desc: "تم الاتصال بنجاح", color: "text-primary" },
    auth_failed: { label: "فشل الاتصال", desc: "يرجى المحاولة مرة أخرى", color: "text-destructive" },
  };
  const c = configs[status];
  if (!c) return null;
  return (
    <div className={`text-center text-sm font-medium ${c.color}`}>
      {c.label}
      <p className="text-xs text-muted-foreground font-normal mt-0.5">{c.desc}</p>
    </div>
  );
}

function StatBox({ color, icon, label, value, large }: {
  color: "green" | "red" | "orange"; icon: JSX.Element;
  label: string; value: number; large?: boolean;
}) {
  const colorMap = {
    green: "bg-green-50 text-green-600 dark:bg-green-900/20",
    red: "bg-red-50 text-red-600 dark:bg-red-900/20",
    orange: "bg-orange-50 text-orange-600 dark:bg-orange-900/20",
  };
  return (
    <div className={`rounded-xl p-3 ${colorMap[color]} text-center`}>
      <div className="flex justify-center mb-1">{icon}</div>
      <p className={`font-bold ${large ? "text-2xl" : "text-lg"} leading-none`}>{value}</p>
      <p className="text-xs mt-1 opacity-80">{label}</p>
    </div>
  );
}
