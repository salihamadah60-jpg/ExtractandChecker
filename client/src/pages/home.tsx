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
  Loader2, Wifi, WifiOff, LogOut, RefreshCw, Shield,
  Link2, QrCode, Hash, ArrowRight, Users, Megaphone,
  FolderOpen, PlusCircle, FileJson, History, ChevronDown,
  ChevronUp, UserPlus, Clock, CheckCheck,
} from "lucide-react";
import { SiWhatsapp, SiTelegram } from "react-icons/si";

type WAStatus = "disconnected" | "connecting" | "qr_ready" | "pairing" | "connected" | "auth_failed";
type Step = "upload" | "links" | "connect" | "checking" | "results";
type ConnectMode = "qr" | "pair" | "saved";

interface CheckResult {
  link: string;
  status: "pending" | "valid" | "invalid" | "error";
  info?: string;
  name?: string;
  members?: number;
  description?: string;
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
interface JoinSession {
  status: "running" | "done" | "error" | "paused";
  total: number;
  progress: number;
  joined: number;
  failed: number;
  startedAt: string;
  completedAt?: string;
  currentLink?: string;
}
interface WAStatusRes {
  status: WAStatus;
  qrCode: string | null;
  pairingCode: string | null;
  session: CheckSession | null;
  hasSavedSession: boolean;
}
interface FilteredSummaryRes {
  groups: number;
  ads: number;
  descriptionLinks: number;
  descriptionLinksData: string[];
}
interface NewRoundRes {
  success: boolean;
  newWhatsapp: number;
  newTelegram: number;
  skipped: number;
  total: number;
}
interface PreviousResultsRes {
  hasPreviousSession: boolean;
  uploadedFileName?: string;
  completedAt?: string;
  startedAt?: string;
  total?: number;
  valid?: number;
  invalid?: number;
  errors?: number;
  groups?: number;
  ads?: number;
  descriptionLinks?: number;
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
  const [connectMode, setConnectMode] = useState<ConnectMode>("qr");
  const [phone, setPhone] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isNewRoundDragging, setIsNewRoundDragging] = useState(false);
  const [newRoundData, setNewRoundData] = useState<NewRoundRes | null>(null);
  // Extra options panel state
  const [showExtraPanel, setShowExtraPanel] = useState(false);
  const [extraPanelMode, setExtraPanelMode] = useState<"upload" | "join" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const newRoundFileRef = useRef<HTMLInputElement>(null);
  const extraUploadRef = useRef<HTMLInputElement>(null);

  const { data: waData, refetch: refetchWA } = useQuery<WAStatusRes>({
    queryKey: ["/api/whatsapp/status"],
    refetchInterval: step === "connect" || step === "checking" ? 2000 : 5000,
  });

  const { data: progressData } = useQuery<{ session: CheckSession | null }>({
    queryKey: ["/api/whatsapp/progress"],
    refetchInterval: step === "checking" ? 1000 : false,
  });

  const { data: filteredSummary, refetch: refetchSummary } = useQuery<FilteredSummaryRes>({
    queryKey: ["/api/whatsapp/filtered-summary"],
    enabled: step === "results",
    refetchInterval: false,
  });

  const { data: joinProgressData } = useQuery<{ joinSession: JoinSession | null }>({
    queryKey: ["/api/whatsapp/join-progress"],
    refetchInterval: extraPanelMode === "join" ? 1000 : false,
  });

  const { data: previousResults } = useQuery<PreviousResultsRes>({
    queryKey: ["/api/previous-results"],
    refetchInterval: false,
  });

  const waStatus = waData?.status ?? "disconnected";
  const qrCode = waData?.qrCode ?? null;
  const pairingCode = waData?.pairingCode ?? null;
  const hasSavedSession = waData?.hasSavedSession ?? false;
  const session = progressData?.session ?? waData?.session ?? null;
  const joinSession = joinProgressData?.joinSession ?? null;

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

  const newRoundUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload-new-round", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "خطأ في الرفع");
      return data as NewRoundRes;
    },
    onSuccess: (data) => {
      setNewRoundData(data);
      if (data.total === 0) {
        toast({ title: "لا روابط جديدة", description: "جميع الروابط تم فحصها مسبقاً", variant: "destructive" });
      } else {
        toast({ title: `${data.total} رابط جديد`, description: `تجاهل ${data.skipped} مكرر` });
      }
    },
    onError: (err: any) => {
      toast({ title: "خطأ", description: err.message, variant: "destructive" });
    },
  });

  const connectQRMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/connect", {}),
    onSuccess: () => { setStep("connect"); setConnectMode("qr"); qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const connectPairMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/pair", { phone }),
    onSuccess: () => { setStep("connect"); setConnectMode("pair"); qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const connectSavedMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/use-saved-session", {}),
    onSuccess: () => { setStep("connect"); qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const resendPairMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/pair/resend", { phone }),
    onSuccess: () => { toast({ title: "تم الإرسال" }); qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }); },
    onError: (err: any) => toast({ title: "فشل", description: err.message, variant: "destructive" }),
  });

  const checkMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/check", {}),
    onSuccess: () => { setStep("checking"); qc.invalidateQueries({ queryKey: ["/api/whatsapp/progress"] }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const checkNewRoundMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/check-new-round", {}),
    onSuccess: () => {
      setNewRoundData(null);
      setShowExtraPanel(false);
      setExtraPanelMode(null);
      setStep("checking");
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/progress"] });
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const joinGroupsMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/join-groups", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/whatsapp/join-progress"] }),
    onError: (err: any) => toast({ title: "خطأ في الانضمام", description: err.message, variant: "destructive" }),
  });

  const disconnectMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/disconnect", {}),
    onSuccess: () => { setStep("links"); qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }); },
  });

  // Auto-start checking when WhatsApp connects (from connect step)
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
      refetchSummary();
    }
  }, [session?.status, step]);

  const handleFile = useCallback((file: File) => {
    if (!file.name.match(/\.docx?$/i)) {
      toast({ title: "خطأ", description: "يجب أن يكون الملف بصيغة DOCX", variant: "destructive" });
      return;
    }
    uploadMutation.mutate(file);
  }, [uploadMutation]);

  const handleNewRoundFile = useCallback((file: File) => {
    if (!file.name.match(/\.docx?$/i)) {
      toast({ title: "خطأ", description: "يجب أن يكون الملف بصيغة DOCX", variant: "destructive" });
      return;
    }
    newRoundUploadMutation.mutate(file);
  }, [newRoundUploadMutation]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    const file = e.dataTransfer.files[0]; if (file) handleFile(file);
  }, [handleFile]);

  const onNewRoundDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsNewRoundDragging(false);
    const file = e.dataTransfer.files[0]; if (file) handleNewRoundFile(file);
  }, [handleNewRoundFile]);

  const handleConnectClick = () => {
    if (connectMode === "qr") connectQRMutation.mutate();
    else if (connectMode === "pair") connectPairMutation.mutate();
    else if (connectMode === "saved") connectSavedMutation.mutate();
  };

  const isConnectPending = connectQRMutation.isPending || connectPairMutation.isPending || connectSavedMutation.isPending;
  const progressPct = session ? Math.round((session.progress / session.total) * 100) : 0;
  const validResults = session?.results.filter((r) => r.status === "valid") ?? [];
  const invalidResults = session?.results.filter((r) => r.status === "invalid") ?? [];
  const errorResults = session?.results.filter((r) => r.status === "error") ?? [];
  const joinPct = joinSession ? Math.round((joinSession.progress / joinSession.total) * 100) : 0;

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
                }`}>
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

            {/* Previous session card */}
            {previousResults?.hasPreviousSession && (
              <Card className="border-primary/40 bg-primary/5">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-9 h-9 rounded-full bg-primary/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <History className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">نتائج سابقة محفوظة</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {previousResults.uploadedFileName && (
                          <span className="font-mono bg-muted px-1.5 py-0.5 rounded ml-1">{previousResults.uploadedFileName}</span>
                        )}
                        {previousResults.completedAt && (
                          <span>· اكتمل {formatDate(previousResults.completedAt)}</span>
                        )}
                      </p>
                    </div>
                  </div>

                  {/* Stats row */}
                  <div className="grid grid-cols-4 gap-2 mb-3">
                    <div className="bg-background rounded-lg p-2 text-center border">
                      <p className="font-bold text-base leading-none">{previousResults.total ?? 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">إجمالي</p>
                    </div>
                    <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-2 text-center border border-green-100 dark:border-green-900">
                      <p className="font-bold text-base leading-none text-green-600">{previousResults.valid ?? 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">صالحة</p>
                    </div>
                    <div className="bg-background rounded-lg p-2 text-center border">
                      <p className="font-bold text-base leading-none text-primary">{previousResults.groups ?? 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">مجموعات</p>
                    </div>
                    <div className="bg-background rounded-lg p-2 text-center border">
                      <p className="font-bold text-base leading-none text-orange-500">{previousResults.ads ?? 0}</p>
                      <p className="text-xs text-muted-foreground mt-1">إعلانات</p>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" className="flex-1 min-w-0"
                      onClick={() => window.open("/api/whatsapp/download-groups", "_blank")}
                      disabled={!previousResults.groups}
                      data-testid="button-prev-download-groups">
                      <Download className="w-3.5 h-3.5 ml-1.5" />
                      <span className="truncate">ملف المجموعات ({previousResults.groups ?? 0})</span>
                    </Button>
                    <Button size="sm" variant="outline" className="flex-1 min-w-0"
                      onClick={() => window.open("/api/whatsapp/download-ads", "_blank")}
                      disabled={!previousResults.ads}
                      data-testid="button-prev-download-ads">
                      <Download className="w-3.5 h-3.5 ml-1.5" />
                      <span className="truncate">ملف الإعلانات ({previousResults.ads ?? 0})</span>
                    </Button>
                    <Button size="sm" className="flex-1 min-w-0"
                      onClick={() => { setStep("results"); refetchSummary(); }}
                      data-testid="button-prev-view-results">
                      <CheckCheck className="w-3.5 h-3.5 ml-1.5" />
                      عرض النتائج الكاملة
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="border-2 border-dashed transition-colors"
              style={{ borderColor: isDragging ? "hsl(var(--primary))" : undefined }}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}>
              <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
                {uploadMutation.isPending ? (
                  <><Loader2 className="w-12 h-12 text-primary animate-spin" /><p className="text-muted-foreground">جاري استخراج الروابط...</p></>
                ) : (
                  <>
                    <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors ${isDragging ? "bg-primary" : "bg-muted"}`}>
                      <Upload className={`w-8 h-8 ${isDragging ? "text-primary-foreground" : "text-muted-foreground"}`} />
                    </div>
                    <div className="text-center">
                      <p className="font-semibold">اسحب وأفلت ملف DOCX هنا</p>
                      <p className="text-sm text-muted-foreground mt-1">أو اضغط لاختيار الملف</p>
                    </div>
                    <Button variant="outline" onClick={() => fileRef.current?.click()} data-testid="button-browse-file">
                      <FileText className="w-4 h-4 ml-2" />اختيار ملف DOCX
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
                  <div className="flex items-start gap-2"><SiWhatsapp className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" /><span>روابط مجموعات <code className="text-xs bg-muted px-1 rounded">chat.whatsapp.com/...</code></span></div>
                  <div className="flex items-start gap-2"><SiWhatsapp className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" /><span>روابط أرقام <code className="text-xs bg-muted px-1 rounded">wa.me/...</code></span></div>
                  <div className="flex items-start gap-2"><SiTelegram className="w-4 h-4 text-blue-500 mt-0.5 flex-shrink-0" /><span>روابط تيليغرام <code className="text-xs bg-muted px-1 rounded">t.me/...</code></span></div>
                  <div className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" /><span>يزيل الروابط المكررة تلقائياً</span></div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ── Step: Links preview ── */}
        {step === "links" && (
          <div className="space-y-5">
            <div className="grid sm:grid-cols-2 gap-4">
              <Card>
                <CardContent className="pt-5">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center"><SiWhatsapp className="w-5 h-5 text-primary" /></div>
                    <div><p className="font-bold text-2xl leading-none">{linkCounts.whatsapp}</p><p className="text-sm text-muted-foreground">رابط واتساب</p></div>
                  </div>
                  <Button className="w-full" variant="outline" onClick={() => window.open("/api/download/whatsapp", "_blank")} disabled={!linkCounts.whatsapp} data-testid="button-download-whatsapp">
                    <Download className="w-4 h-4 ml-2" />تحميل روابط واتساب
                  </Button>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center"><SiTelegram className="w-5 h-5 text-blue-500" /></div>
                    <div><p className="font-bold text-2xl leading-none">{linkCounts.telegram}</p><p className="text-sm text-muted-foreground">رابط تيليغرام</p></div>
                  </div>
                  <Button className="w-full" variant="outline" onClick={() => window.open("/api/download/telegram", "_blank")} disabled={!linkCounts.telegram} data-testid="button-download-telegram">
                    <Download className="w-4 h-4 ml-2" />تحميل روابط تيليغرام
                  </Button>
                </CardContent>
              </Card>
            </div>

            {linkCounts.whatsapp > 0 && (
              <Card className="border-primary/30 bg-primary/5">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="w-5 h-5 text-primary" />فحص روابط واتساب
                  </CardTitle>
                  <CardDescription>اختر طريقة الاتصال للتحقق من الروابط النشطة.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* 3 connection method cards */}
                  <div className="grid grid-cols-3 gap-2">
                    {/* QR */}
                    <div className={`border rounded-lg p-3 cursor-pointer transition-colors ${connectMode === "qr" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
                      onClick={() => setConnectMode("qr")} data-testid="select-qr-mode">
                      <div className="flex items-center gap-1.5 mb-1"><QrCode className="w-4 h-4 text-primary flex-shrink-0" /><span className="text-xs font-medium">رمز QR</span></div>
                      <p className="text-xs text-muted-foreground leading-tight">امسح من واتساب</p>
                    </div>
                    {/* Pairing */}
                    <div className={`border rounded-lg p-3 cursor-pointer transition-colors ${connectMode === "pair" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
                      onClick={() => setConnectMode("pair")} data-testid="select-pair-mode">
                      <div className="flex items-center gap-1.5 mb-1"><Hash className="w-4 h-4 text-primary flex-shrink-0" /><span className="text-xs font-medium">رمز الربط</span></div>
                      <p className="text-xs text-muted-foreground leading-tight">أدخل رقم الهاتف</p>
                    </div>
                    {/* Saved session */}
                    <div className={`border rounded-lg p-3 cursor-pointer transition-colors relative ${
                      connectMode === "saved" ? "border-primary bg-primary/5" :
                      hasSavedSession ? "border-border hover:border-primary/50" : "border-border opacity-50 cursor-not-allowed"
                    }`}
                      onClick={() => hasSavedSession && setConnectMode("saved")} data-testid="select-saved-mode">
                      <div className="flex items-center gap-1.5 mb-1">
                        <History className="w-4 h-4 text-primary flex-shrink-0" />
                        <span className="text-xs font-medium">جلسة محفوظة</span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-tight">
                        {hasSavedSession ? "استخدام الجلسة المحفوظة" : "لا توجد جلسة"}
                      </p>
                    </div>
                  </div>

                  {connectMode === "pair" && (
                    <Input value={phone} onChange={(e) => setPhone(e.target.value)}
                      placeholder="966512345678 (بدون +)" className="font-mono text-sm" dir="ltr"
                      data-testid="input-phone" />
                  )}

                  {connectMode === "saved" && hasSavedSession && (
                    <div className="flex items-center gap-2 text-xs bg-primary/5 border border-primary/20 rounded-lg px-3 py-2">
                      <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
                      <span className="text-foreground">جلسة واتساب محفوظة — سيتم الاتصال مباشرةً دون مسح QR</span>
                    </div>
                  )}

                  <Button className="w-full" size="lg"
                    onClick={handleConnectClick}
                    disabled={isConnectPending || (connectMode === "pair" && !phone.trim()) || (connectMode === "saved" && !hasSavedSession)}
                    data-testid="button-check-links">
                    {isConnectPending ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <SiWhatsapp className="w-4 h-4 ml-2" />}
                    فحص الروابط
                  </Button>
                </CardContent>
              </Card>
            )}

            <Button variant="ghost" size="sm" onClick={() => setStep("upload")} data-testid="button-reupload">
              <ArrowRight className="w-4 h-4 ml-1" />رفع ملف آخر
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
                  {connectMode === "qr" ? "امسح رمز QR" : connectMode === "pair" ? "أدخل رمز الربط" : "جاري الاتصال بالجلسة المحفوظة"}
                </CardTitle>
                <CardDescription>
                  {connectMode === "qr" ? "افتح واتساب → الأجهزة المرتبطة → ربط جهاز → امسح الرمز" :
                   connectMode === "pair" ? "افتح واتساب → الأجهزة المرتبطة → ربط بالرقم → أدخل الرمز" :
                   "يتم الاتصال تلقائياً باستخدام بيانات الجلسة المحفوظة"}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-4">
                <WAStatusCard status={waStatus} />

                {connectMode === "qr" && qrCode && (
                  <div className="p-3 bg-white rounded-xl shadow border">
                    <img src={qrCode} alt="QR Code" className="w-56 h-56" data-testid="img-qr-code" />
                  </div>
                )}
                {connectMode === "qr" && !qrCode && (waStatus === "connecting" || waStatus === "qr_ready") && (
                  <div className="w-56 h-56 bg-muted rounded-xl flex items-center justify-center">
                    <Loader2 className="w-10 h-10 text-primary animate-spin" />
                  </div>
                )}

                {connectMode === "pair" && pairingCode && (
                  <div className="flex flex-col items-center gap-3 w-full">
                    <p className="text-xs text-muted-foreground">أدخل هذا الرمز في واتساب</p>
                    <div className="text-4xl font-mono font-bold tracking-widest bg-muted px-6 py-4 rounded-xl border w-full text-center" data-testid="text-pairing-code">
                      {pairingCode}
                    </div>
                    <Button variant="outline" size="sm" className="w-full" onClick={() => resendPairMutation.mutate()} disabled={resendPairMutation.isPending} data-testid="button-resend-pair">
                      {resendPairMutation.isPending ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 ml-1" />}
                      إعادة إرسال الرمز
                    </Button>
                  </div>
                )}
                {connectMode === "pair" && !pairingCode && (waStatus === "pairing" || waStatus === "connecting") && (
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="w-8 h-8 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground">جاري الحصول على رمز الربط...</p>
                  </div>
                )}

                {connectMode === "saved" && (waStatus === "connecting" || waStatus === "disconnected") && (
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="w-8 h-8 text-primary animate-spin" />
                    <p className="text-sm text-muted-foreground">جاري الاتصال بالجلسة المحفوظة...</p>
                  </div>
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
            <Button variant="outline" className="w-full" onClick={() => { disconnectMutation.mutate(); setStep("links"); }} data-testid="button-cancel-connect">
              <ArrowRight className="w-4 h-4 ml-1" />رجوع
            </Button>
          </div>
        )}

        {/* ── Step: Checking — loading ── */}
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
                    {session.status === "running" ? <Loader2 className="w-5 h-5 text-primary animate-spin" /> : <CheckCircle2 className="w-5 h-5 text-primary" />}
                    {session.status === "running" ? "جاري فحص الروابط..." : "اكتمل الفحص"}
                  </CardTitle>
                  <Badge variant="outline">{session.progress} / {session.total}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <div className="flex justify-between text-sm"><span className="text-muted-foreground">التقدم</span><span className="font-medium">{progressPct}%</span></div>
                  <Progress value={progressPct} className="h-2" />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <StatBox color="green" icon={<CheckCircle2 className="w-4 h-4" />} label="صالحة" value={validResults.length} />
                  <StatBox color="red" icon={<XCircle className="w-4 h-4" />} label="منتهية" value={invalidResults.length} />
                  <StatBox color="orange" icon={<AlertCircle className="w-4 h-4" />} label="خطأ" value={errorResults.length} />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">آخر النتائج</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                  {session.results.filter((r) => r.status !== "pending").slice(-20).reverse().map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs py-1 border-b border-border/50 last:border-0">
                      {r.status === "valid" && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />}
                      {r.status === "invalid" && <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                      {r.status === "error" && <AlertCircle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />}
                      <span className="font-mono truncate text-muted-foreground flex-1">{r.link}</span>
                      <span className={`flex-shrink-0 ${r.status === "valid" ? "text-green-600" : r.status === "invalid" ? "text-red-600" : "text-orange-600"}`}>
                        {r.name ? `${r.name}${r.members !== undefined ? ` ${r.members}` : ""}` : (r.info ?? r.status)}
                      </span>
                    </div>
                  ))}
                  {!session.results.filter((r) => r.status !== "pending").length && (
                    <p className="text-center text-muted-foreground py-4 text-sm">في انتظار النتائج...</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="p-3 bg-muted rounded-lg flex items-start gap-2 text-xs text-muted-foreground">
              <Shield className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
              <span>تأخير عشوائي بين 1 و1.5 ثانية لحماية الحساب</span>
            </div>
          </div>
        )}

        {/* ── Step: Results ── */}
        {step === "results" && session && (
          <div className="space-y-5">
            {/* Overall stats */}
            <div className="grid grid-cols-3 gap-4">
              <StatBox color="green" icon={<CheckCircle2 className="w-5 h-5" />} label="صالحة" value={validResults.length} large />
              <StatBox color="red" icon={<XCircle className="w-5 h-5" />} label="منتهية" value={invalidResults.length} large />
              <StatBox color="orange" icon={<AlertCircle className="w-5 h-5" />} label="أخطاء" value={errorResults.length} large />
            </div>

            {/* Two output files */}
            <div className="grid sm:grid-cols-2 gap-4">
              <Card className="border-green-200 dark:border-green-900/40">
                <CardContent className="pt-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                      <Users className="w-4 h-4 text-green-600" />
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold text-sm">ملف المجموعات</p>
                      <p className="text-xs text-muted-foreground">أكثر من 50 عضواً · و10-50 بدون وصف</p>
                    </div>
                    {filteredSummary && <Badge variant="secondary">{filteredSummary.groups}</Badge>}
                  </div>
                  <Button className="w-full" variant="outline"
                    onClick={() => window.open("/api/whatsapp/download-groups", "_blank")}
                    disabled={!filteredSummary || filteredSummary.groups === 0}
                    data-testid="button-download-groups">
                    <Download className="w-4 h-4 ml-2" />تحميل ملف المجموعات
                  </Button>
                </CardContent>
              </Card>

              <Card className="border-orange-200 dark:border-orange-900/40">
                <CardContent className="pt-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                      <Megaphone className="w-4 h-4 text-orange-600" />
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold text-sm">ملف الإعلانات</p>
                      <p className="text-xs text-muted-foreground">10–50 عضواً مع وصف</p>
                    </div>
                    {filteredSummary && <Badge variant="secondary">{filteredSummary.ads}</Badge>}
                  </div>
                  <Button className="w-full" variant="outline"
                    onClick={() => window.open("/api/whatsapp/download-ads", "_blank")}
                    disabled={!filteredSummary || filteredSummary.ads === 0}
                    data-testid="button-download-ads">
                    <Download className="w-4 h-4 ml-2" />تحميل ملف الإعلانات
                  </Button>
                </CardContent>
              </Card>
            </div>

            {/* Description links info */}
            {filteredSummary && filteredSummary.descriptionLinks > 0 && (
              <Card className="border-blue-200 dark:border-blue-900/40 bg-blue-50/50 dark:bg-blue-900/10">
                <CardContent className="pt-4 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
                    <Link2 className="w-4 h-4 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">روابط من الأوصاف</p>
                    <p className="text-xs text-muted-foreground">تم استخراج {filteredSummary.descriptionLinks} رابط من أوصاف المجموعات — يمكن إضافتها للجولة التالية</p>
                  </div>
                  <Badge>{filteredSummary.descriptionLinks}</Badge>
                </CardContent>
              </Card>
            )}

            {/* ── 4 action buttons ── */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Button variant="outline"
                onClick={() => window.open("/api/whatsapp/download-groups", "_blank")}
                disabled={!filteredSummary || filteredSummary.groups === 0}
                className="flex-col h-16 gap-1 text-xs"
                data-testid="button-dl-groups-bottom">
                <Download className="w-4 h-4" />
                <span>ملف المجموعات</span>
              </Button>
              <Button variant="outline"
                onClick={() => window.open("/api/whatsapp/download-ads", "_blank")}
                disabled={!filteredSummary || filteredSummary.ads === 0}
                className="flex-col h-16 gap-1 text-xs"
                data-testid="button-dl-ads-bottom">
                <Download className="w-4 h-4" />
                <span>ملف الإعلانات</span>
              </Button>
              <Button variant="outline"
                onClick={() => { setShowExtraPanel(true); setExtraPanelMode("upload"); setNewRoundData(null); }}
                className="flex-col h-16 gap-1 text-xs"
                data-testid="button-new-links">
                <PlusCircle className="w-4 h-4" />
                <span>رفع ملف جديد</span>
              </Button>
              <Button variant="outline"
                onClick={() => { setShowExtraPanel(!showExtraPanel && extraPanelMode !== null ? false : true); setExtraPanelMode(showExtraPanel && extraPanelMode !== null ? null : extraPanelMode ?? "upload"); }}
                className={`flex-col h-16 gap-1 text-xs ${showExtraPanel ? "border-primary text-primary bg-primary/5" : ""}`}
                data-testid="button-extra-options">
                {showExtraPanel && extraPanelMode !== null ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                <span>خيارات إضافية</span>
              </Button>
            </div>

            {/* ── Extra options panel ── */}
            {showExtraPanel && (
              <Card className="border-primary/30">
                <CardContent className="pt-4 pb-4 space-y-3">
                  {/* Choice row */}
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      className={`border rounded-lg p-3 text-right transition-colors ${extraPanelMode === "upload" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
                      onClick={() => { setExtraPanelMode("upload"); setNewRoundData(null); }}
                      data-testid="option-upload">
                      <div className="flex items-center gap-2 mb-1">
                        <FolderOpen className="w-4 h-4 text-primary flex-shrink-0" />
                        <span className="text-sm font-medium">رفع ملف جديد للفحص</span>
                      </div>
                      <p className="text-xs text-muted-foreground">رفع ملف DOCX جديد وإزالة المكررات ثم الفحص</p>
                    </button>
                    <button
                      className={`border rounded-lg p-3 text-right transition-colors ${extraPanelMode === "join" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
                      onClick={() => setExtraPanelMode("join")}
                      data-testid="option-join">
                      <div className="flex items-center gap-2 mb-1">
                        <UserPlus className="w-4 h-4 text-primary flex-shrink-0" />
                        <span className="text-sm font-medium">الانضمام للمجموعات</span>
                      </div>
                      <p className="text-xs text-muted-foreground">ينضم تلقائياً للمجموعات المحفوظة بتأخير 2–5 ث</p>
                    </button>
                  </div>

                  {/* Upload sub-panel */}
                  {extraPanelMode === "upload" && (
                    <div className="space-y-3 border-t pt-3">
                      {!newRoundData ? (
                        <div
                          className={`border-2 border-dashed rounded-lg p-5 flex flex-col items-center gap-3 cursor-pointer transition-colors ${isNewRoundDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
                          onDragOver={(e) => { e.preventDefault(); setIsNewRoundDragging(true); }}
                          onDragLeave={() => setIsNewRoundDragging(false)}
                          onDrop={onNewRoundDrop}
                          onClick={() => newRoundFileRef.current?.click()}
                          data-testid="dropzone-new-round">
                          {newRoundUploadMutation.isPending ? (
                            <><Loader2 className="w-7 h-7 text-primary animate-spin" /><p className="text-sm text-muted-foreground">جاري المعالجة...</p></>
                          ) : (
                            <>
                              <FolderOpen className={`w-7 h-7 ${isNewRoundDragging ? "text-primary" : "text-muted-foreground"}`} />
                              <p className="text-sm font-medium">اسحب ملف DOCX الجديد</p>
                            </>
                          )}
                          <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); newRoundFileRef.current?.click(); }} data-testid="button-select-new-round-file">
                            <FileText className="w-3.5 h-3.5 ml-1.5" />قم برفع ملف
                          </Button>
                          <input ref={newRoundFileRef} type="file" accept=".docx,.doc" className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleNewRoundFile(f); }} data-testid="input-new-round-file" />
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="grid grid-cols-3 gap-3">
                            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-3 text-center">
                              <p className="font-bold text-lg text-green-600">{newRoundData.newWhatsapp}</p>
                              <p className="text-xs text-muted-foreground">واتساب جديد</p>
                            </div>
                            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 text-center">
                              <p className="font-bold text-lg text-blue-600">{newRoundData.newTelegram}</p>
                              <p className="text-xs text-muted-foreground">تيليغرام جديد</p>
                            </div>
                            <div className="bg-muted rounded-lg p-3 text-center">
                              <p className="font-bold text-lg text-muted-foreground">{newRoundData.skipped}</p>
                              <p className="text-xs text-muted-foreground">مكررة</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg p-2.5">
                            <FileJson className="w-4 h-4 flex-shrink-0" />
                            <span>تم حفظ الروابط الجديدة في ملف JSON جديد تلقائياً</span>
                          </div>
                          <div className="flex gap-2">
                            <Button className="flex-1" onClick={() => checkNewRoundMutation.mutate()}
                              disabled={checkNewRoundMutation.isPending || newRoundData.total === 0 || waStatus !== "connected"}
                              data-testid="button-start-new-round">
                              {checkNewRoundMutation.isPending ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <SiWhatsapp className="w-4 h-4 ml-2" />}
                              بدء الفحص ({newRoundData.total})
                            </Button>
                            <Button variant="outline" onClick={() => setNewRoundData(null)}>إلغاء</Button>
                          </div>
                          {waStatus !== "connected" && (
                            <p className="text-xs text-destructive text-center">واتساب غير متصل. يرجى الاتصال أولاً.</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Join sub-panel */}
                  {extraPanelMode === "join" && (
                    <div className="space-y-3 border-t pt-3">
                      {(!joinSession || joinSession.status === "done" || joinSession.status === "paused") && (
                        <div className="space-y-3">
                          <div className="flex items-start gap-2 text-xs bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
                            <Clock className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                            <div>
                              <p className="font-medium text-yellow-700 dark:text-yellow-400">تأخير آمن: 2–5 ثانية بين كل انضمام، و دقيقة راحة كل 30 مجموعة</p>
                              <p className="text-yellow-600 dark:text-yellow-500 mt-0.5">سيتم الانضمام إلى {validResults.length} مجموعة صالحة</p>
                            </div>
                          </div>
                          {joinSession?.status === "done" && (
                            <div className="flex items-center gap-2 text-xs bg-green-50 dark:bg-green-900/20 rounded-lg p-3 border border-green-200 dark:border-green-800">
                              <CheckCheck className="w-4 h-4 text-green-600 flex-shrink-0" />
                              <span className="text-green-700 dark:text-green-400">اكتمل الانضمام — {joinSession.joined} ناجح، {joinSession.failed} فشل</span>
                            </div>
                          )}
                          <Button className="w-full" onClick={() => joinGroupsMutation.mutate()}
                            disabled={joinGroupsMutation.isPending || waStatus !== "connected" || !validResults.length}
                            data-testid="button-start-join">
                            {joinGroupsMutation.isPending ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <UserPlus className="w-4 h-4 ml-2" />}
                            {joinSession?.status === "done" ? "إعادة الانضمام" : "بدء الانضمام للمجموعات"}
                          </Button>
                          {waStatus !== "connected" && <p className="text-xs text-destructive text-center">واتساب غير متصل</p>}
                        </div>
                      )}

                      {joinSession?.status === "running" && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium flex items-center gap-2">
                              <Loader2 className="w-4 h-4 text-primary animate-spin" />
                              جاري الانضمام...
                            </p>
                            <Badge variant="outline">{joinSession.progress} / {joinSession.total}</Badge>
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between text-xs text-muted-foreground">
                              <span>التقدم</span><span>{joinPct}%</span>
                            </div>
                            <Progress value={joinPct} className="h-2" />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-2.5 text-center">
                              <p className="font-bold text-lg text-green-600">{joinSession.joined}</p>
                              <p className="text-xs text-muted-foreground">انضمام ناجح</p>
                            </div>
                            <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-2.5 text-center">
                              <p className="font-bold text-lg text-red-600">{joinSession.failed}</p>
                              <p className="text-xs text-muted-foreground">فشل</p>
                            </div>
                          </div>
                          {joinSession.currentLink && (
                            <p className="text-xs text-muted-foreground font-mono truncate bg-muted rounded px-2 py-1">
                              {joinSession.currentLink}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
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
                        {r.name && <span className="text-xs font-medium">{r.name}{r.members !== undefined ? ` — ${r.members} عضو` : ""}</span>}
                      </div>
                      <Badge variant={r.status === "valid" ? "default" : "secondary"} className="text-xs flex-shrink-0">
                        {r.status === "valid" ? "صالح" : r.status === "invalid" ? "منتهٍ" : r.status === "error" ? "خطأ" : "معلق"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
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
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${c.cls}`} data-testid="status-pill">
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
      {c.label}<p className="text-xs text-muted-foreground font-normal mt-0.5">{c.desc}</p>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("ar-SA", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function StatBox({ color, icon, label, value, large }: { color: "green"|"red"|"orange"; icon: JSX.Element; label: string; value: number; large?: boolean }) {
  const colorMap = { green: "bg-green-50 text-green-600 dark:bg-green-900/20", red: "bg-red-50 text-red-600 dark:bg-red-900/20", orange: "bg-orange-50 text-orange-600 dark:bg-orange-900/20" };
  return (
    <div className={`rounded-xl p-3 ${colorMap[color]} text-center`}>
      <div className="flex justify-center mb-1">{icon}</div>
      <p className={`font-bold ${large ? "text-2xl" : "text-lg"} leading-none`}>{value}</p>
      <p className="text-xs mt-1 opacity-80">{label}</p>
    </div>
  );
}

