import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import {
  Upload, FileText, Download, CheckCircle2, XCircle, AlertCircle,
  Loader2, Wifi, WifiOff, LogOut, RefreshCw, Shield,
  Link2, QrCode, Hash, ArrowRight, ArrowLeft, Users, Megaphone,
  FolderOpen, PlusCircle, FileJson, History, ChevronDown,
  ChevronUp, UserPlus, Clock, CheckCheck, Trash2,
  Pause, Play, Square, Menu, X, MessageCircle, Send, LayoutDashboard,
} from "lucide-react";
import { SiWhatsapp, SiTelegram } from "react-icons/si";

type WAStatus = "disconnected" | "connecting" | "qr_ready" | "pairing" | "connected" | "auth_failed";
type Step = "upload" | "links" | "checking" | "results";
type ConnectMode = "qr" | "pair" | "saved";

interface WASessionInfo {
  id: string;
  displayName: string;
  phoneNumber?: string;
  status: WAStatus;
  isActive: boolean;
}

interface CheckResult {
  link: string;
  status: "pending" | "valid" | "invalid" | "error";
  info?: string;
  name?: string;
  members?: number;
  description?: string;
}
interface RateLimitInfo {
  waitUntil: number;
  retryCount: number;
  backoffSec: number;
  link: string;
}

interface CheckSession {
  id: string;
  links?: string[];
  results?: CheckResult[];
  progress: number;
  total: number;
  status: "idle" | "running" | "done" | "error" | "paused";
  startedAt: string;
  completedAt?: string;
  completedBatches: number[];
  validCount?: number;
  invalidCount?: number;
  errorCount?: number;
  recentResults?: CheckResult[];
  rateLimitInfo?: RateLimitInfo | null;
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
  joinedLinks: string[];
  failedLinks: string[];
}
interface WAStatusRes {
  status: WAStatus;
  qrCode: string | null;
  pairingCode: string | null;
  session: CheckSession | null;
  hasSavedSession: boolean;
  sessions: WASessionInfo[];
  activeSessionId: string | null;
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
interface FreshUploadRes {
  success: boolean;
  whatsapp: number;
  telegram: number;
  descriptionLinksAdded: number;
}
interface PreviousResultsRes {
  hasPreviousSession: boolean;
  extractedWA?: number;
  extractedTG?: number;
  uploadedFileName?: string;
  sessionStatus?: "idle" | "running" | "done" | "error" | null;
  sessionProgress?: number;
  sessionTotal?: number;
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
interface CoordinatorStatus { active: string | null; isRunning: boolean; }
interface RepoCounts { Pending: number; Joined: number; Ignored: number; Left: number; }
interface JoinProgress2 {
  status: "running" | "done" | "paused" | "stopped" | "error";
  total: number; processed: number; joined: number; ignored: number; failed: number; skipped_ads: number;
  currentLink?: string; stopReason?: string; startedAt: string; completedAt?: string;
}
interface LeaveQueueEntry { url: string; groupJid?: string; enqueuedAt: string; reason?: string; }
interface AdMessage { _id: string; text: string; createdAt: string; sentCount: number; lastSentAt?: string; }
interface PublishProgress {
  status: "running" | "done" | "stopped" | "error";
  total: number; processed: number; sent: number; failed: number;
  currentGroup?: string; startedAt: string; completedAt?: string;
}
interface ReaderStats {
  status: "running" | "stopped" | "error";
  messagesReceived: number; messagesSkippedAds: number; linksFound: number; linksNew: number;
  startedAt: string; stoppedAt?: string;
}

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "رفع الملف" },
  { key: "links", label: "الروابط والاتصال" },
  { key: "checking", label: "الفحص" },
  { key: "results", label: "النتائج" },
];

export default function Home() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("upload");
  const [linkCounts, setLinkCounts] = useState({ whatsapp: 0, telegram: 0 });
  const [connectMode, setConnectMode] = useState<ConnectMode>("qr");
  const [isConnecting, setIsConnecting] = useState(false);
  const [phone, setPhone] = useState<string>(() => {
    try { return localStorage.getItem("wa_phone") || ""; } catch { return ""; }
  });

  useEffect(() => {
    try { if (phone) localStorage.setItem("wa_phone", phone); } catch {}
  }, [phone]);

  const [rateLimitCountdown, setRateLimitCountdown] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [isNewRoundDragging, setIsNewRoundDragging] = useState(false);
  const [isFreshDragging, setIsFreshDragging] = useState(false);
  const [newRoundData, setNewRoundData] = useState<NewRoundRes | null>(null);
  const [showFreshUpload, setShowFreshUpload] = useState(false);
  // Extra options panel state
  const [showExtraPanel, setShowExtraPanel] = useState(false);
  const [extraPanelMode, setExtraPanelMode] = useState<"upload" | "join" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showJoinSidePanel, setShowJoinSidePanel] = useState(false);
  const [showPublisherPanel, setShowPublisherPanel] = useState(false);
  const [showReaderPanel, setShowReaderPanel] = useState(false);
  const [showLeavePanel, setShowLeavePanel] = useState(false);
  const [newAdText, setNewAdText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const newRoundFileRef = useRef<HTMLInputElement>(null);
  const extraUploadRef = useRef<HTMLInputElement>(null);
  const freshUploadRef = useRef<HTMLInputElement>(null);

  const { data: waData, refetch: refetchWA } = useQuery<WAStatusRes>({
    queryKey: ["/api/whatsapp/status"],
    refetchInterval: (step === "links" && isConnecting) ? 3000 : step === "checking" ? 4000 : 8000,
  });

  const { data: progressData } = useQuery<{ session: CheckSession | null }>({
    queryKey: ["/api/whatsapp/progress"],
    refetchInterval: step === "checking" ? 2000 : false,
  });

  const { data: filteredSummary, refetch: refetchSummary } = useQuery<FilteredSummaryRes>({
    queryKey: ["/api/whatsapp/filtered-summary"],
    enabled: step === "results",
    refetchInterval: false,
  });

  const { data: joinProgressData } = useQuery<{ joinSession: JoinSession | null }>({
    queryKey: ["/api/whatsapp/join-progress"],
    refetchInterval: extraPanelMode === "join" ? 2000 : 15000,
  });

  const { data: previousResults } = useQuery<PreviousResultsRes>({
    queryKey: ["/api/previous-results"],
    refetchInterval: false,
  });
  const { data: coordinatorData } = useQuery<CoordinatorStatus>({
    queryKey: ["/api/coordinator/status"],
    refetchInterval: 3000,
  });
  const { data: repoCounts, refetch: refetchRepoCounts } = useQuery<RepoCounts>({
    queryKey: ["/api/links-repository/counts"],
    refetchInterval: 15000,
  });
  const { data: joinProgress2Data, refetch: refetchJoinProgress2 } = useQuery<{ progress: JoinProgress2 | null }>({
    queryKey: ["/api/join/progress"],
    refetchInterval: coordinatorData?.active === "joining" ? 2000 : 15000,
  });
  const { data: leaveQueueData, refetch: refetchLeaveQueue } = useQuery<{ queue: LeaveQueueEntry[]; count: number }>({
    queryKey: ["/api/leave/queue"],
    refetchInterval: showLeavePanel ? 5000 : false,
    enabled: true,
  });
  const { data: publisherAdsData, refetch: refetchPublisherAds } = useQuery<AdMessage[]>({
    queryKey: ["/api/publisher/ads"],
    refetchInterval: false,
    enabled: true,
  });
  const { data: publisherProgressData } = useQuery<{ progress: PublishProgress | null }>({
    queryKey: ["/api/publisher/progress"],
    refetchInterval: coordinatorData?.active === "publishing" ? 2000 : false,
  });
  const { data: readerStatsData } = useQuery<{ stats: ReaderStats | null; isRunning: boolean }>({
    queryKey: ["/api/reader/stats"],
    refetchInterval: 5000,
  });

  // Restore check session state on page refresh — runs once when data arrives
  const hasRestoredRef = useRef(false);
  useEffect(() => {
    if (hasRestoredRef.current || previousResults === undefined) return;
    hasRestoredRef.current = true;

    const { extractedWA = 0, extractedTG = 0, sessionStatus, hasPreviousSession } = previousResults;

    // Restore link counts whenever there are extracted links
    if (extractedWA > 0 || extractedTG > 0) {
      setLinkCounts({ whatsapp: extractedWA, telegram: extractedTG });
    }

    if (hasPreviousSession && sessionStatus === "done") {
      setStep("results");
    } else if (sessionStatus === "running" || sessionStatus === "idle") {
      setStep("checking");
    } else if (extractedWA > 0) {
      setStep("links");
    }
  }, [previousResults]);

  // Restore join panel on page refresh — runs once when join data arrives
  const hasRestoredJoinRef = useRef(false);
  useEffect(() => {
    if (hasRestoredJoinRef.current || joinProgressData === undefined) return;
    hasRestoredJoinRef.current = true;

    const js = joinProgressData.joinSession;
    if (js && (js.status === "done" || js.status === "running" || js.status === "paused" || js.status === "error")) {
      setShowExtraPanel(true);
      setExtraPanelMode("join");
    }
  }, [joinProgressData]);

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

  const uploadMultipleMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      const res = await fetch("/api/upload-multiple", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "خطأ في الرفع");
      return data;
    },
    onSuccess: (data) => {
      setLinkCounts({ whatsapp: data.whatsapp, telegram: data.telegram });
      setStep("links");
      toast({ title: `تم استخراج الروابط من ${data.filesProcessed} ملف`, description: `${data.whatsapp} واتساب، ${data.telegram} تيليغرام` });
    },
    onError: (err: any) => {
      toast({ title: "خطأ", description: err.message, variant: "destructive" });
    },
  });

  const newRoundUploadMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
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

  const freshUploadMutation = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      const res = await fetch("/api/upload-fresh", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "خطأ في الرفع");
      return data as FreshUploadRes;
    },
    onSuccess: (data) => {
      setLinkCounts({ whatsapp: data.whatsapp, telegram: data.telegram });
      setShowFreshUpload(false);
      setShowExtraPanel(false);
      setExtraPanelMode(null);
      qc.invalidateQueries({ queryKey: ["/api/previous-results"] });
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] });
      const descMsg = data.descriptionLinksAdded > 0 ? ` (+ ${data.descriptionLinksAdded} من الأوصاف)` : "";
      toast({ title: `تم استخراج ${data.whatsapp} رابط واتساب${descMsg}` });
      if (waStatus === "connected") {
        checkMutation.mutate();
      } else {
        setStep("links");
      }
    },
    onError: (err: any) => {
      toast({ title: "خطأ", description: err.message, variant: "destructive" });
    },
  });

  const createSessionMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/sessions", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] });
      toast({ title: "تم إنشاء حساب جديد", description: "اختره وابدأ الاتصال" });
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const deleteSessionMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/sessions/${id}`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] });
      toast({ title: "تم حذف الحساب" });
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const activateSessionMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/sessions/${id}/activate`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const disconnectSessionMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/sessions/${id}/disconnect`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const pauseCheckMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/check/pause", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/whatsapp/progress"] }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const resumeCheckMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/check/resume", {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/whatsapp/progress"] }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const stopCheckMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/check/stop", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/progress"] });
      setTimeout(() => { setStep("results"); refetchSummary(); }, 1500);
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const retryErrorsMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/check/retry-errors", {}),
    onSuccess: (data: any) => {
      setStep("checking");
      toast({ title: `إعادة فحص ${data.retrying} رابط بها أخطاء` });
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/progress"] });
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const connectQRMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/connect", {}),
    onSuccess: () => { setIsConnecting(true); setConnectMode("qr"); qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const connectPairMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/pair", { phone }),
    onSuccess: () => { setIsConnecting(true); setConnectMode("pair"); qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const connectSavedMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/use-saved-session", {}),
    onSuccess: () => { setIsConnecting(true); qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }); },
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
    onSuccess: () => { setIsConnecting(false); setStep("links"); qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }); },
  });

  const clearCredsMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/clear-credentials", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] });
      toast({ title: "تم حذف بيانات الجلسة", description: "يجب مسح رمز QR من جديد للاتصال." });
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  // Auto-start checking when WhatsApp connects (from links step)
  useEffect(() => {
    if (waStatus === "connected" && step === "links" && isConnecting) {
      setIsConnecting(false);
      setStep("checking");
      checkMutation.mutate();
    }
  }, [waStatus, step, isConnecting]);

  // Auto-advance to results when checking finishes
  useEffect(() => {
    if (session?.status === "done" && step === "checking") {
      setStep("results");
      refetchSummary();
    }
  }, [session?.status, step]);

  // Crash recovery: auto-navigate to checking when session resumes in background
  useEffect(() => {
    if (!session) return;
    if (session.status === "running" && step !== "checking" && step !== "results") {
      setStep("checking");
    }
  }, [session?.status]);

  // Rate-limit countdown timer
  useEffect(() => {
    const rl = session?.rateLimitInfo;
    if (!rl) { setRateLimitCountdown(0); return; }
    const update = () => setRateLimitCountdown(Math.max(0, Math.ceil((rl.waitUntil - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [session?.rateLimitInfo]);

  const handleFiles = useCallback((fileList: FileList | File[]) => {
    const arr = Array.from(fileList);
    const valid = arr.filter((f) => f.name.match(/\.docx?$/i));
    if (!valid.length) {
      toast({ title: "خطأ", description: "يجب أن تكون الملفات بصيغة DOCX", variant: "destructive" });
      return;
    }
    if (valid.length === 1) {
      uploadMutation.mutate(valid[0]);
    } else {
      uploadMultipleMutation.mutate(valid);
    }
  }, [uploadMutation, uploadMultipleMutation]);

  const handleFile = useCallback((file: File) => handleFiles([file]), [handleFiles]);

  const handleNewRoundFiles = useCallback((fileList: FileList | File[]) => {
    const arr = Array.from(fileList).filter((f) => f.name.match(/\.docx?$/i));
    if (!arr.length) { toast({ title: "خطأ", description: "يجب أن تكون الملفات بصيغة DOCX", variant: "destructive" }); return; }
    newRoundUploadMutation.mutate(arr);
  }, [newRoundUploadMutation]);

  const handleNewRoundFile = useCallback((file: File) => handleNewRoundFiles([file]), [handleNewRoundFiles]);

  const handleFreshFiles = useCallback((fileList: FileList | File[]) => {
    const arr = Array.from(fileList).filter((f) => f.name.match(/\.docx?$/i));
    if (!arr.length) { toast({ title: "خطأ", description: "يجب أن تكون الملفات بصيغة DOCX", variant: "destructive" }); return; }
    freshUploadMutation.mutate(arr);
  }, [freshUploadMutation]);

  const handleFreshFile = useCallback((file: File) => handleFreshFiles([file]), [handleFreshFiles]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const onNewRoundDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsNewRoundDragging(false);
    if (e.dataTransfer.files.length) handleNewRoundFiles(e.dataTransfer.files);
  }, [handleNewRoundFiles]);

  const handleConnectClick = () => {
    if (connectMode === "qr") connectQRMutation.mutate();
    else if (connectMode === "pair") connectPairMutation.mutate();
    else if (connectMode === "saved") connectSavedMutation.mutate();
  };

  const isConnectPending = connectQRMutation.isPending || connectPairMutation.isPending || connectSavedMutation.isPending;
  const progressPct = session ? Math.round((session.progress / session.total) * 100) : 0;
  const validCount = session?.validCount ?? session?.results?.filter((r) => r.status === "valid").length ?? 0;
  const invalidCount = session?.invalidCount ?? session?.results?.filter((r) => r.status === "invalid").length ?? 0;
  const errorCount = session?.errorCount ?? session?.results?.filter((r) => r.status === "error").length ?? 0;
  const recentResults: CheckResult[] = session?.recentResults ?? session?.results?.filter((r) => r.status !== "pending").slice(-20) ?? [];
  const joinPct = joinSession ? Math.round((joinSession.progress / joinSession.total) * 100) : 0;

  const isCoordinatorBusy = coordinatorData?.isRunning ?? false;
  const activeFunction = coordinatorData?.active ?? null;
  const joinProgress2 = joinProgress2Data?.progress ?? null;
  const join2Pct = joinProgress2 ? Math.round((joinProgress2.processed / Math.max(1, joinProgress2.total)) * 100) : 0;
  const publishProgress = publisherProgressData?.progress ?? null;
  const publishPct = publishProgress ? Math.round((publishProgress.processed / Math.max(1, publishProgress.total)) * 100) : 0;
  const readerStats = readerStatsData?.stats ?? null;
  const isReaderRunning = readerStatsData?.isRunning ?? false;
  const leaveQueue = leaveQueueData?.queue ?? [];

  const startJoin2Mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/join/start", {}),
    onSuccess: () => { toast({ title: "بدأ الانضمام من المستودع" }); void refetchJoinProgress2(); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const stopJoin2Mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/join/stop", {}),
    onSuccess: () => { toast({ title: "جاري إيقاف الانضمام..." }); void refetchJoinProgress2(); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const startLeaveMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/leave/start", {}),
    onSuccess: () => { toast({ title: "بدأت معالجة قائمة المغادرة" }); void refetchLeaveQueue(); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const stopLeaveMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/leave/stop", {}),
    onSuccess: () => toast({ title: "جاري إيقاف المغادرة..." }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const dequeueLeaveMutation = useMutation({
    mutationFn: (url: string) => apiRequest("DELETE", "/api/leave/dequeue", { url }),
    onSuccess: () => { void refetchLeaveQueue(); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const addAdMutation = useMutation({
    mutationFn: (text: string) => apiRequest("POST", "/api/publisher/ads", { text }),
    onSuccess: () => { setNewAdText(""); void refetchPublisherAds(); toast({ title: "تمت إضافة الإعلان" }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const removeAdMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/publisher/ads/${id}`, {}),
    onSuccess: () => { void refetchPublisherAds(); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const startPublishMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/publisher/start", {}),
    onSuccess: () => toast({ title: "بدأ نشر الإعلانات" }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const stopPublishMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/publisher/stop", {}),
    onSuccess: () => toast({ title: "جاري إيقاف النشر..." }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const startReaderMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/reader/start", {}),
    onSuccess: () => toast({ title: "بدأت قراءة الرسائل" }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const stopReaderMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/reader/stop", {}),
    onSuccess: () => toast({ title: "تم إيقاف القراءة" }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const currentStepIdx = STEPS.findIndex((s) => s.key === step);

  const canNavigateTo = (target: Step): boolean => {
    const hasLinks = linkCounts.whatsapp > 0 || linkCounts.telegram > 0;
    switch (target) {
      case "upload": return true;
      case "links": return hasLinks;
      case "checking": return !!session;
      case "results": return session?.status === "done";
      default: return false;
    }
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl">

      {/* ── Fixed sidebar toggle button ── */}
      <button
        className="fixed bottom-6 left-6 z-50 w-14 h-14 bg-primary text-primary-foreground rounded-2xl shadow-xl flex items-center justify-center hover:bg-primary/90 active:scale-95 transition-all"
        onClick={() => setSidebarOpen(o => !o)}
        data-testid="button-sidebar-toggle"
      >
        {sidebarOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
      </button>

      {/* ── Backdrop ── */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
      )}

      {/* ── Side panel (physical left, slides in from left) ── */}
      <aside className={`fixed left-0 top-0 h-full w-72 z-50 bg-background border-r shadow-2xl overflow-y-auto transform transition-transform duration-300 ease-in-out ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`} dir="rtl">
        <div className="p-4 space-y-5">
          {/* Panel header */}
          <div className="flex items-center justify-between pt-2">
            <h2 className="font-bold text-base">القائمة الجانبية</h2>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 rounded-full" onClick={() => setSidebarOpen(false)}>
              <X className="w-4 h-4" />
            </Button>
          </div>

          {/* ── إدارة الجلسات ── */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2.5 flex items-center gap-1.5">
              <SiWhatsapp className="w-3.5 h-3.5 text-primary" />إدارة الجلسات
            </p>
            <div className="space-y-1.5">
              {waData?.sessions && waData.sessions.length > 0 ? waData.sessions.map((sess) => {
                const sLabel = sess.status === "connected" ? "متصل" : sess.status === "connecting" ? "جاري الاتصال..." : sess.status === "qr_ready" ? "في انتظار QR" : sess.status === "pairing" ? "جاري الربط..." : sess.status === "auth_failed" ? "فشل التحقق" : "غير متصل";
                return (
                  <div key={sess.id} className={`flex items-center gap-2 p-2 rounded-lg border transition-colors ${sess.isActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${sess.status === "connected" ? "bg-primary/15" : "bg-muted"}`}>
                      <SiWhatsapp className={`w-3.5 h-3.5 ${sess.status === "connected" ? "text-primary" : "text-muted-foreground"}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate leading-tight">{sess.displayName}</p>
                      <p className="text-[10px] text-muted-foreground">{sLabel}</p>
                    </div>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      {!sess.isActive ? (
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 hover:bg-primary/10" title="تفعيل"
                          onClick={() => activateSessionMutation.mutate(sess.id)}
                          disabled={activateSessionMutation.isPending}
                          data-testid={`sidebar-activate-${sess.id}`}>
                          <Play className="w-3 h-3 text-primary" />
                        </Button>
                      ) : (
                        <Badge variant="default" className="text-[10px] h-5 px-1.5">نشط</Badge>
                      )}
                      {sess.status === "connected" && (
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 hover:bg-orange-50 dark:hover:bg-orange-900/20" title="قطع الاتصال"
                          onClick={() => disconnectSessionMutation.mutate(sess.id)}
                          disabled={disconnectSessionMutation.isPending}
                          data-testid={`sidebar-disconnect-${sess.id}`}>
                          <LogOut className="w-3 h-3 text-orange-500" />
                        </Button>
                      )}
                      {waData.sessions.length > 1 && (
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 hover:bg-destructive/10" title="حذف"
                          onClick={() => { if (confirm("حذف هذا الحساب؟")) deleteSessionMutation.mutate(sess.id); }}
                          disabled={deleteSessionMutation.isPending}
                          data-testid={`sidebar-delete-${sess.id}`}>
                          <Trash2 className="w-3 h-3 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              }) : (
                <p className="text-xs text-muted-foreground text-center py-2">لا توجد جلسات بعد</p>
              )}
              <Button size="sm" variant="outline" className="w-full h-8 text-xs gap-1.5 mt-1"
                onClick={() => createSessionMutation.mutate()}
                disabled={createSessionMutation.isPending}
                data-testid="sidebar-add-session">
                {createSessionMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
                أضف جلسة
              </Button>
            </div>
          </div>

          <hr className="border-border" />

          {/* ── الإجراءات ── */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2.5">الإجراءات</p>
            <div className="space-y-2">

              {/* ── Coordinator status banner ── */}
              {isCoordinatorBusy && (
                <div className="flex items-center gap-2 text-xs bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg px-3 py-2">
                  <Loader2 className="w-3.5 h-3.5 text-yellow-600 animate-spin flex-shrink-0" />
                  <span className="text-yellow-700 dark:text-yellow-400">
                    وظيفة نشطة: <strong>{activeFunction === "joining" ? "الانضمام" : activeFunction === "publishing" ? "النشر" : activeFunction === "reading" ? "القراءة" : activeFunction === "leaving" ? "المغادرة" : activeFunction ?? ""}</strong> — الأزرار الأخرى معطّلة
                  </span>
                </div>
              )}

              {/* ── مستودع الروابط ── */}
              {repoCounts && (
                <div className="border rounded-lg p-2.5 space-y-1.5 bg-muted/30">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">مستودع الروابط</p>
                  <div className="grid grid-cols-4 gap-1 text-center">
                    {([["Pending","معلق","text-yellow-600"],["Joined","منضم","text-green-600"],["Ignored","متجاهل","text-red-500"],["Left","خرج","text-muted-foreground"]] as const).map(([k,l,c]) => (
                      <div key={k} className="bg-background rounded p-1 border">
                        <p className={`font-bold text-sm leading-none ${c}`}>{repoCounts[k as keyof RepoCounts] ?? 0}</p>
                        <p className="text-[9px] text-muted-foreground mt-0.5">{l}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── الانضمام من المستودع (new API) ── */}
              <Button variant="outline" className={`w-full justify-start gap-2 h-10 ${showJoinSidePanel ? "border-primary bg-primary/5" : ""}`}
                onClick={() => setShowJoinSidePanel(o => !o)}
                data-testid="sidebar-join-repo-toggle">
                <UserPlus className="w-4 h-4 text-primary flex-shrink-0" />
                <span className="flex-1 text-right text-sm">الانضمام من المستودع</span>
                {joinProgress2 && <Badge variant={joinProgress2.status === "running" ? "default" : "secondary"} className="text-[10px]">{joinProgress2.joined ?? 0}</Badge>}
                {showJoinSidePanel ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </Button>
              {showJoinSidePanel && (
                <div className="border border-primary/20 rounded-lg p-3 space-y-2 bg-primary/5">
                  {joinProgress2?.status === "running" && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />جاري الانضمام...</span>
                        <Badge variant="outline" className="text-xs">{joinProgress2.processed}/{joinProgress2.total}</Badge>
                      </div>
                      <Progress value={join2Pct} className="h-1.5" />
                      <div className="grid grid-cols-3 gap-1 text-center text-[10px]">
                        <div className="bg-green-50 dark:bg-green-900/20 rounded p-1.5"><p className="font-bold text-green-600">{joinProgress2.joined}</p><p className="text-muted-foreground">ناجح</p></div>
                        <div className="bg-red-50 dark:bg-red-900/20 rounded p-1.5"><p className="font-bold text-red-600">{joinProgress2.failed}</p><p className="text-muted-foreground">فشل</p></div>
                        <div className="bg-muted rounded p-1.5"><p className="font-bold">{joinProgress2.ignored}</p><p className="text-muted-foreground">متجاهل</p></div>
                      </div>
                      {joinProgress2.currentLink && <p className="text-[10px] text-muted-foreground font-mono truncate bg-muted rounded px-2 py-1">{joinProgress2.currentLink}</p>}
                      {joinProgress2.stopReason && <p className="text-[10px] text-destructive bg-destructive/10 rounded p-1.5">{joinProgress2.stopReason}</p>}
                      <Button size="sm" variant="outline" className="w-full text-xs h-8 border-destructive/50 text-destructive hover:bg-destructive/5" onClick={() => stopJoin2Mutation.mutate()} disabled={stopJoin2Mutation.isPending}>
                        <Square className="w-3 h-3 ml-1" />إيقاف
                      </Button>
                    </div>
                  )}
                  {(joinProgress2?.status === "done" || joinProgress2?.status === "stopped") && (
                    <div className="flex items-center gap-1.5 text-xs bg-green-50 dark:bg-green-900/20 rounded p-2 border border-green-200 dark:border-green-800">
                      <CheckCheck className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
                      <span className="text-green-700 dark:text-green-400 font-medium">اكتمل — {joinProgress2.joined} ناجح، {joinProgress2.failed} فشل، {joinProgress2.ignored} متجاهل</span>
                    </div>
                  )}
                  {(!joinProgress2 || joinProgress2.status === "done" || joinProgress2.status === "stopped" || joinProgress2.status === "paused") && (
                    <Button size="sm" className="w-full text-xs h-8"
                      onClick={() => startJoin2Mutation.mutate()}
                      disabled={startJoin2Mutation.isPending || waStatus !== "connected" || isCoordinatorBusy}
                      data-testid="sidebar-start-join2">
                      {startJoin2Mutation.isPending ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" /> : <UserPlus className="w-3.5 h-3.5 ml-1" />}
                      {joinProgress2?.status === "paused" ? "استئناف الانضمام" : "بدء الانضمام"}
                    </Button>
                  )}
                  <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground bg-muted/50 rounded p-2">
                    <Shield className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    <span>يتوقف تلقائياً عند أي خطأ يهدد الحساب (421، حظر، بلاغ)</span>
                  </div>
                </div>
              )}

              {/* ── قرأة الرسائل ── */}
              <Button variant="outline" className={`w-full justify-start gap-2 h-10 ${showReaderPanel ? "border-primary bg-primary/5" : ""}`}
                onClick={() => setShowReaderPanel(o => !o)}
                data-testid="sidebar-read-messages">
                <MessageCircle className="w-4 h-4 text-primary flex-shrink-0" />
                <span className="flex-1 text-right text-sm">قراءة رسائل المجموعات</span>
                {isReaderRunning && <Badge className="text-[10px] bg-green-500">نشط</Badge>}
                {showReaderPanel ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </Button>
              {showReaderPanel && (
                <div className="border border-primary/20 rounded-lg p-3 space-y-2 bg-primary/5">
                  {readerStats && (
                    <div className="grid grid-cols-2 gap-1 text-center text-[10px]">
                      <div className="bg-background rounded p-1.5 border"><p className="font-bold text-sm">{readerStats.messagesReceived}</p><p className="text-muted-foreground">رسالة</p></div>
                      <div className="bg-green-50 dark:bg-green-900/20 rounded p-1.5"><p className="font-bold text-sm text-green-600">{readerStats.linksNew}</p><p className="text-muted-foreground">روابط جديدة</p></div>
                    </div>
                  )}
                  {isReaderRunning ? (
                    <Button size="sm" variant="outline" className="w-full text-xs h-8 border-destructive/50 text-destructive" onClick={() => stopReaderMutation.mutate()} disabled={stopReaderMutation.isPending} data-testid="sidebar-stop-reader">
                      {stopReaderMutation.isPending ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" /> : <Square className="w-3 h-3 ml-1" />}إيقاف القراءة
                    </Button>
                  ) : (
                    <Button size="sm" className="w-full text-xs h-8"
                      onClick={() => startReaderMutation.mutate()}
                      disabled={startReaderMutation.isPending || waStatus !== "connected" || isCoordinatorBusy}
                      data-testid="sidebar-start-reader">
                      {startReaderMutation.isPending ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" /> : <MessageCircle className="w-3.5 h-3.5 ml-1" />}
                      بدء القراءة
                    </Button>
                  )}
                  <p className="text-[10px] text-muted-foreground">تقرأ الرسائل الجديدة فور وصولها وتستخرج الروابط تلقائياً</p>
                </div>
              )}

              {/* ── نشر الإعلانات ── */}
              <Button variant="outline" className={`w-full justify-start gap-2 h-10 ${showPublisherPanel ? "border-orange-400 bg-orange-50 dark:bg-orange-900/10" : ""}`}
                onClick={() => { setShowPublisherPanel(o => !o); if (!publisherAdsData) void refetchPublisherAds(); }}
                data-testid="sidebar-publish">
                <Send className="w-4 h-4 text-orange-500 flex-shrink-0" />
                <span className="flex-1 text-right text-sm">نشر الإعلانات</span>
                {publisherAdsData && <Badge variant="secondary" className="text-[10px]">{publisherAdsData.length} إعلان</Badge>}
                {showPublisherPanel ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </Button>
              {showPublisherPanel && (
                <div className="border border-orange-200 dark:border-orange-800 rounded-lg p-3 space-y-2.5 bg-orange-50/50 dark:bg-orange-900/10">
                  {/* Progress */}
                  {publishProgress?.status === "running" && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs"><span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin text-orange-500" />جاري النشر...</span><Badge variant="outline">{publishProgress.processed}/{publishProgress.total}</Badge></div>
                      <Progress value={publishPct} className="h-1.5" />
                      <div className="grid grid-cols-2 gap-1 text-center text-[10px]">
                        <div className="bg-green-50 rounded p-1.5"><p className="font-bold text-green-600">{publishProgress.sent}</p><p className="text-muted-foreground">أُرسل</p></div>
                        <div className="bg-red-50 rounded p-1.5"><p className="font-bold text-red-600">{publishProgress.failed}</p><p className="text-muted-foreground">فشل</p></div>
                      </div>
                      <Button size="sm" variant="outline" className="w-full text-xs h-8 border-destructive/50 text-destructive" onClick={() => stopPublishMutation.mutate()} disabled={stopPublishMutation.isPending}>
                        <Square className="w-3 h-3 ml-1" />إيقاف النشر
                      </Button>
                    </div>
                  )}
                  {/* Ad list */}
                  {publisherAdsData && publisherAdsData.length > 0 && (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {publisherAdsData.map((ad) => (
                        <div key={ad._id} className="flex items-start gap-1.5 bg-background rounded p-2 border text-xs">
                          <span className="flex-1 line-clamp-2 text-muted-foreground">{ad.text}</span>
                          <div className="flex flex-col items-end gap-1 flex-shrink-0">
                            <Badge variant="outline" className="text-[9px] h-4 px-1">{ad.sentCount}×</Badge>
                            <Button size="sm" variant="ghost" className="h-5 w-5 p-0 hover:bg-destructive/10" onClick={() => removeAdMutation.mutate(ad._id)} disabled={removeAdMutation.isPending} data-testid={`button-remove-ad-${ad._id}`}><Trash2 className="w-3 h-3 text-destructive" /></Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Add ad */}
                  <div className="flex gap-1.5">
                    <Input
                      placeholder="نص الإعلان الجديد..."
                      value={newAdText}
                      onChange={(e) => setNewAdText(e.target.value)}
                      className="flex-1 h-8 text-xs"
                      onKeyDown={(e) => { if (e.key === "Enter" && newAdText.trim()) addAdMutation.mutate(newAdText); }}
                      data-testid="input-new-ad"
                    />
                    <Button size="sm" className="h-8 px-2" onClick={() => addAdMutation.mutate(newAdText)} disabled={addAdMutation.isPending || !newAdText.trim()} data-testid="button-add-ad">
                      {addAdMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlusCircle className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                  {/* Start button */}
                  {(!publishProgress || publishProgress.status !== "running") && (
                    <Button size="sm" className="w-full text-xs h-8 bg-orange-500 hover:bg-orange-600 text-white"
                      onClick={() => startPublishMutation.mutate()}
                      disabled={startPublishMutation.isPending || waStatus !== "connected" || isCoordinatorBusy || !publisherAdsData?.length}
                      data-testid="button-start-publish">
                      {startPublishMutation.isPending ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" /> : <Send className="w-3.5 h-3.5 ml-1" />}
                      بدء النشر للمجموعات المنضمة
                    </Button>
                  )}
                </div>
              )}

              {/* ── قائمة المغادرة ── */}
              <Button variant="outline" className={`w-full justify-start gap-2 h-10 ${showLeavePanel ? "border-red-300 bg-red-50 dark:bg-red-900/10" : ""}`}
                onClick={() => { setShowLeavePanel(o => !o); void refetchLeaveQueue(); }}
                data-testid="sidebar-leave-queue">
                <LogOut className="w-4 h-4 text-red-500 flex-shrink-0" />
                <span className="flex-1 text-right text-sm">قائمة المغادرة</span>
                {leaveQueue.length > 0 && <Badge variant="destructive" className="text-[10px]">{leaveQueue.length}</Badge>}
                {showLeavePanel ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </Button>
              {showLeavePanel && (
                <div className="border border-red-200 dark:border-red-800 rounded-lg p-3 space-y-2 bg-red-50/50 dark:bg-red-900/10">
                  {leaveQueue.length > 0 ? (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {leaveQueue.map((entry) => (
                        <div key={entry.url} className="flex items-center gap-1.5 bg-background rounded p-2 border text-xs">
                          <span className="flex-1 font-mono truncate text-muted-foreground">{entry.url}</span>
                          <Button size="sm" variant="ghost" className="h-5 w-5 p-0 hover:bg-destructive/10 flex-shrink-0" onClick={() => dequeueLeaveMutation.mutate(entry.url)} disabled={dequeueLeaveMutation.isPending}><Trash2 className="w-3 h-3 text-destructive" /></Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground text-center py-2">قائمة المغادرة فارغة</p>
                  )}
                  <div className="flex gap-1.5">
                    <Button size="sm" className="flex-1 h-8 text-xs bg-red-500 hover:bg-red-600 text-white"
                      onClick={() => startLeaveMutation.mutate()}
                      disabled={startLeaveMutation.isPending || waStatus !== "connected" || isCoordinatorBusy || leaveQueue.length === 0}
                      data-testid="button-start-leave">
                      {startLeaveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" /> : <LogOut className="w-3.5 h-3.5 ml-1" />}
                      مغادرة الكل ({leaveQueue.length})
                    </Button>
                    {activeFunction === "leaving" && (
                      <Button size="sm" variant="outline" className="h-8 px-2 border-destructive/50 text-destructive" onClick={() => stopLeaveMutation.mutate()} disabled={stopLeaveMutation.isPending} data-testid="button-stop-leave">
                        <Square className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">تأخير 5–15 ث قبل كل مغادرة لحماية الحساب</p>
                </div>
              )}

            </div>
          </div>
        </div>
      </aside>

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
            <Link href="/dashboard">
              <Button size="sm" variant="ghost" className="text-xs gap-1.5" data-testid="link-dashboard">
                <LayoutDashboard className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">لوحة التحكم</span>
              </Button>
            </Link>
            {(waStatus === "connected" || waStatus === "qr_ready" || waStatus === "pairing") && (
              <Button size="sm" variant="outline" onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending} data-testid="button-disconnect">
                <LogOut className="w-3.5 h-3.5 ml-1" />
                <span className="text-xs">قطع</span>
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive hover:bg-destructive/10 px-2"
              onClick={() => { if (confirm("هل تريد حذف بيانات الجلسة؟ ستحتاج لمسح رمز QR مجدداً للاتصال.")) clearCredsMutation.mutate(); }}
              disabled={clearCredsMutation.isPending} data-testid="button-clear-credentials"
              title="حذف بيانات تسجيل الدخول">
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        {/* Steps */}
        <div className="flex items-center justify-between mb-8 overflow-x-auto pb-1">
          {STEPS.map((s, i) => {
            const navigable = canNavigateTo(s.key) && s.key !== step;
            return (
              <div key={s.key} className="flex items-center gap-1 flex-shrink-0">
                <div className="flex flex-col items-center gap-1">
                  <button
                    onClick={() => navigable && setStep(s.key)}
                    disabled={!navigable}
                    data-testid={`step-bubble-${s.key}`}
                    className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all focus:outline-none ${
                      i < currentStepIdx ? "bg-primary text-primary-foreground" :
                      i === currentStepIdx ? "bg-primary text-primary-foreground ring-4 ring-primary/20" :
                      "bg-muted text-muted-foreground"
                    } ${navigable ? "cursor-pointer hover:opacity-80" : "cursor-default"}`}
                  >
                    {i < currentStepIdx ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                  </button>
                  <span className={`text-xs whitespace-nowrap ${
                    i === currentStepIdx ? "text-primary font-medium" :
                    i < currentStepIdx ? "text-foreground" : "text-muted-foreground"
                  }`}>{s.label}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`w-8 sm:w-12 h-0.5 mx-1 mb-4 rounded ${i < currentStepIdx ? "bg-primary" : "bg-border"}`} />
                )}
              </div>
            );
          })}
        </div>

        {/* Back button */}
        {currentStepIdx > 0 && step !== "checking" && !(step === "links" && isConnecting) && (
          <div className="mb-4">
            <Button variant="ghost" size="sm" onClick={() => setStep(STEPS[currentStepIdx - 1].key)}
              data-testid="button-back">
              <ArrowRight className="w-4 h-4 ml-1" />رجوع
            </Button>
          </div>
        )}

        {/* ── Step: Upload ── */}
        {step === "upload" && (
          <div className="space-y-4">

            {/* Crash-recovery banner: suspended in-progress session */}
            {session && session.status === "idle" && session.progress < session.total && (
              <Card className="border-orange-400/60 bg-orange-50 dark:bg-orange-900/20">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-full bg-orange-100 dark:bg-orange-900/40 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Loader2 className="w-4 h-4 text-orange-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm text-orange-800 dark:text-orange-300">جلسة فحص متوقفة</p>
                      <p className="text-xs text-orange-700 dark:text-orange-400 mt-0.5">
                        تم الفحص حتى الآن: <strong>{session.progress}</strong> من <strong>{session.total}</strong> رابط — ستستأنف تلقائياً عند اتصال واتساب
                      </p>
                      <div className="mt-2.5">
                        <div className="w-full bg-orange-200 dark:bg-orange-800/40 rounded-full h-1.5">
                          <div
                            className="bg-orange-500 h-1.5 rounded-full transition-all"
                            style={{ width: `${Math.round((session.progress / session.total) * 100)}%` }}
                          />
                        </div>
                        <p className="text-[10px] text-orange-600 dark:text-orange-400 mt-1 text-left">
                          {Math.round((session.progress / session.total) * 100)}٪
                        </p>
                      </div>
                    </div>
                    <Button size="sm" className="flex-shrink-0 bg-orange-500 hover:bg-orange-600 text-white text-xs h-8 px-3"
                      onClick={() => setStep("connect")}
                      data-testid="button-resume-session">
                      استئناف
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

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

                  {/* Previous join session info */}
                  {joinSession && (joinSession.status === "done" || joinSession.status === "paused") && (
                    <div className="mt-3 pt-3 border-t flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-muted-foreground">
                          آخر جلسة انضمام:
                          <span className={`mr-1 font-medium ${joinSession.status === "done" ? "text-green-600" : "text-orange-600"}`}>
                            {joinSession.joined} ناجح، {joinSession.failed} فشل
                          </span>
                        </p>
                      </div>
                      <Button size="sm" variant="outline"
                        onClick={() => window.open("/api/whatsapp/download-join-results", "_blank")}
                        data-testid="button-prev-download-join">
                        <Download className="w-3.5 h-3.5 ml-1.5" />
                        نتائج الانضمام
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Card className="border-2 border-dashed transition-colors"
              style={{ borderColor: isDragging ? "hsl(var(--primary))" : undefined }}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}>
              <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
                {(uploadMutation.isPending || uploadMultipleMutation.isPending) ? (
                  <><Loader2 className="w-12 h-12 text-primary animate-spin" /><p className="text-muted-foreground">{uploadMultipleMutation.isPending ? "جاري دمج الملفات واستخراج الروابط..." : "جاري استخراج الروابط..."}</p></>
                ) : (
                  <>
                    <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors ${isDragging ? "bg-primary" : "bg-muted"}`}>
                      <Upload className={`w-8 h-8 ${isDragging ? "text-primary-foreground" : "text-muted-foreground"}`} />
                    </div>
                    <div className="text-center">
                      <p className="font-semibold">اسحب وأفلت ملفات DOCX هنا</p>
                      <p className="text-sm text-muted-foreground mt-1">أو اضغط لاختيار ملف أو أكثر</p>
                    </div>
                    <Button variant="outline" onClick={() => fileRef.current?.click()} data-testid="button-browse-file">
                      <FileText className="w-4 h-4 ml-2" />اختيار ملف أو ملفات DOCX
                    </Button>
                    <input ref={fileRef} type="file" accept=".docx,.doc" multiple className="hidden"
                      onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); e.target.value = ""; }}
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

        {/* ── Step: Links & Connect (merged) ── */}
        {step === "links" && (
          <div className="space-y-5">

            {/* auth_failed banner */}
            {waStatus === "auth_failed" && (
              <Card className="border-destructive/40 bg-destructive/5">
                <CardContent className="pt-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center flex-shrink-0">
                    <WifiOff className="w-5 h-5 text-destructive" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-destructive text-sm">انتهت صلاحية الجلسة</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      رفضت واتساب بيانات الجلسة المحفوظة — يجب مسحها قبل إعادة الاتصال.
                    </p>
                  </div>
                  <Button
                    variant="destructive" size="sm"
                    className="flex-shrink-0 whitespace-nowrap"
                    onClick={() => {
                      if (confirm("هل تريد حذف بيانات الجلسة القديمة؟ ستحتاج لمسح QR أو إدخال رمز ربط جديد."))
                        clearCredsMutation.mutate();
                    }}
                    disabled={clearCredsMutation.isPending}
                    data-testid="button-clear-session-banner"
                  >
                    {clearCredsMutation.isPending
                      ? <Loader2 className="w-3.5 h-3.5 ml-1.5 animate-spin" />
                      : <Trash2 className="w-3.5 h-3.5 ml-1.5" />}
                    مسح الجلسة القديمة
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Link count cards — always visible */}
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

            {/* ── Sessions management — always visible ── */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <SiWhatsapp className="w-4 h-4 text-primary" />الحسابات المحفوظة
                  </CardTitle>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1 px-2"
                    onClick={() => createSessionMutation.mutate()}
                    disabled={createSessionMutation.isPending}
                    data-testid="button-add-session">
                    {createSessionMutation.isPending
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <UserPlus className="w-3 h-3" />}
                    أضف جلسة
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                {waData && waData.sessions && waData.sessions.length > 0 ? (
                  <div className="space-y-1.5">
                    {waData.sessions.map((sess) => (
                      <div key={sess.id} className={`flex items-center gap-2.5 p-2 rounded-lg border transition-colors ${sess.isActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/30"}`}>
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${sess.status === "connected" ? "bg-primary/15" : "bg-muted"}`}>
                          <SiWhatsapp className={`w-4 h-4 ${sess.status === "connected" ? "text-primary" : "text-muted-foreground"}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate leading-none mb-0.5">{sess.displayName}</p>
                          <p className="text-xs text-muted-foreground">{
                            sess.status === "connected" ? "متصل" :
                            sess.status === "connecting" ? "جاري الاتصال..." :
                            sess.status === "qr_ready" ? "في انتظار QR" :
                            sess.status === "pairing" ? "جاري الربط..." :
                            sess.status === "auth_failed" ? "فشل التحقق" : "غير متصل"
                          }</p>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {sess.isActive
                            ? <Badge variant="default" className="text-xs h-6 px-2">نشط</Badge>
                            : (
                              <Button size="sm" variant="outline" className="h-7 text-xs px-2"
                                onClick={() => activateSessionMutation.mutate(sess.id)}
                                disabled={activateSessionMutation.isPending || isConnecting}
                                data-testid={`button-activate-session-${sess.id}`}>
                                تفعيل
                              </Button>
                            )
                          }
                          {waData.sessions.length > 1 && (
                            <Button size="sm" variant="ghost"
                              className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={() => { if (confirm("حذف هذا الحساب؟")) deleteSessionMutation.mutate(sess.id); }}
                              disabled={deleteSessionMutation.isPending || isConnecting}
                              data-testid={`button-delete-session-${sess.id}`}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-3">
                    لا توجد جلسات محفوظة — أضف جلسة جديدة لبدء الاتصال
                  </p>
                )}
              </CardContent>
            </Card>

            {linkCounts.whatsapp > 0 && (
              !isConnecting ? (
                /* ── Connection method selector ── */
                <Card className="border-primary/30 bg-primary/5">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Shield className="w-5 h-5 text-primary" />فحص روابط واتساب
                    </CardTitle>
                    <CardDescription>اختر طريقة الاتصال للتحقق من الروابط النشطة.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-3 gap-2">
                      <div className={`border rounded-lg p-3 cursor-pointer transition-colors ${connectMode === "qr" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
                        onClick={() => setConnectMode("qr")} data-testid="select-qr-mode">
                        <div className="flex items-center gap-1.5 mb-1"><QrCode className="w-4 h-4 text-primary flex-shrink-0" /><span className="text-xs font-medium">رمز QR</span></div>
                        <p className="text-xs text-muted-foreground leading-tight">امسح من واتساب</p>
                      </div>
                      <div className={`border rounded-lg p-3 cursor-pointer transition-colors ${connectMode === "pair" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"}`}
                        onClick={() => setConnectMode("pair")} data-testid="select-pair-mode">
                        <div className="flex items-center gap-1.5 mb-1"><Hash className="w-4 h-4 text-primary flex-shrink-0" /><span className="text-xs font-medium">رمز الربط</span></div>
                        <p className="text-xs text-muted-foreground leading-tight">أدخل رقم الهاتف</p>
                      </div>
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
              ) : (
                /* ── Connecting / QR / Pairing inline UI ── */
                <div className="space-y-4">
                  {/* QR / Pairing / Status card */}
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

                  <Button variant="outline" className="w-full"
                    onClick={() => { setIsConnecting(false); disconnectMutation.mutate(); }}
                    data-testid="button-cancel-connect">
                    <ArrowRight className="w-4 h-4 ml-1" />رجوع
                  </Button>
                </div>
              )
            )}

            {!isConnecting && (
              <Button variant="ghost" size="sm" onClick={() => setStep("upload")} data-testid="button-reupload">
                <ArrowRight className="w-4 h-4 ml-1" />رفع ملف آخر
              </Button>
            )}
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
            {/* Rate-limit cooldown banner */}
            {session.rateLimitInfo && rateLimitCountdown > 0 && (
              <Card className="border-orange-300 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/30">
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-orange-100 dark:bg-orange-900/40 flex items-center justify-center flex-shrink-0">
                      <Clock className="w-5 h-5 text-orange-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-orange-700 dark:text-orange-400">تقييد المعدل — جاري الانتظار</p>
                      <p className="text-xs text-muted-foreground">المحاولة {session.rateLimitInfo.retryCount} · الرابط: <span className="font-mono truncate">{session.rateLimitInfo.link.slice(-30)}</span></p>
                    </div>
                    <div className="flex-shrink-0 text-3xl font-mono font-bold text-orange-600 dark:text-orange-400 tabular-nums w-14 text-center">
                      {rateLimitCountdown}s
                    </div>
                  </div>
                  <Progress
                    value={Math.round(Math.max(0, 1 - rateLimitCountdown / Math.max(1, session.rateLimitInfo.backoffSec)) * 100)}
                    className="h-1.5 mt-3 bg-orange-100 dark:bg-orange-900/20 [&>div]:bg-orange-500"
                  />
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 text-base">
                    {session.status === "running" ? <Loader2 className="w-5 h-5 text-primary animate-spin" /> : session.status === "paused" ? <Pause className="w-5 h-5 text-orange-500" /> : <CheckCircle2 className="w-5 h-5 text-primary" />}
                    {session.status === "running" ? "جاري فحص الروابط..." : session.status === "paused" ? "الفحص متوقف مؤقتاً" : "اكتمل الفحص"}
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
                  <StatBox color="green" icon={<CheckCircle2 className="w-4 h-4" />} label="صالحة" value={validCount} />
                  <StatBox color="red" icon={<XCircle className="w-4 h-4" />} label="منتهية" value={invalidCount} />
                  <StatBox color="orange" icon={<AlertCircle className="w-4 h-4" />} label="خطأ" value={errorCount} />
                </div>
              </CardContent>
            </Card>

            {/* ── Pause / Resume / Stop controls ── */}
            {(session.status === "running" || session.status === "paused") && (
              <div className="flex gap-2">
                {session.status === "running" ? (
                  <Button variant="outline" className="flex-1 gap-2 border-orange-300 text-orange-700 hover:bg-orange-50 dark:hover:bg-orange-900/20"
                    onClick={() => pauseCheckMutation.mutate()}
                    disabled={pauseCheckMutation.isPending}
                    data-testid="button-pause-check">
                    {pauseCheckMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pause className="w-4 h-4" />}
                    إيقاف مؤقت
                  </Button>
                ) : (
                  <Button variant="outline" className="flex-1 gap-2 border-primary text-primary hover:bg-primary/5"
                    onClick={() => resumeCheckMutation.mutate()}
                    disabled={resumeCheckMutation.isPending}
                    data-testid="button-resume-check">
                    {resumeCheckMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    استئناف الفحص
                  </Button>
                )}
                <Button variant="outline" className="flex-1 gap-2 border-destructive/50 text-destructive hover:bg-destructive/5"
                  onClick={() => { if (confirm("إيقاف الفحص نهائياً والانتقال للنتائج؟")) stopCheckMutation.mutate(); }}
                  disabled={stopCheckMutation.isPending}
                  data-testid="button-stop-check">
                  {stopCheckMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                  إيقاف نهائي
                </Button>
              </div>
            )}
            {session.status === "paused" && (
              <div className="flex items-center gap-2 text-xs bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg px-3 py-2">
                <Pause className="w-3.5 h-3.5 text-orange-600 flex-shrink-0" />
                <span className="text-orange-700 dark:text-orange-400">الفحص متوقف مؤقتاً — اضغط استئناف لمتابعة الفحص أو إيقاف نهائي للانتقال للنتائج</span>
              </div>
            )}

            {/* Retry errors — shown when checking is done and there are errors */}
            {session.status === "done" && errorCount > 0 && (
              <Button variant="outline" className="w-full gap-2 border-orange-300 text-orange-700 hover:bg-orange-50 dark:hover:bg-orange-900/20"
                onClick={() => retryErrorsMutation.mutate()}
                disabled={retryErrorsMutation.isPending || waStatus !== "connected"}
                data-testid="button-retry-errors">
                {retryErrorsMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                إعادة فحص الأخطاء ({errorCount})
              </Button>
            )}

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">آخر النتائج</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                  {[...recentResults].reverse().map((r, i) => (
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
                  {!recentResults.length && (
                    <p className="text-center text-muted-foreground py-4 text-sm">في انتظار النتائج...</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="p-3 bg-muted rounded-lg flex items-start gap-2 text-xs text-muted-foreground">
              <Shield className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
              <span>تأخير عشوائي بين 1 و1.5 ثانية لحماية الحساب</span>
            </div>

            {/* Completed batch download buttons */}
            {session.completedBatches && session.completedBatches.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Download className="w-4 h-4 text-primary" />
                    تحميل الدفعات المكتملة
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {session.completedBatches.map((batchNum) => (
                      <a
                        key={batchNum}
                        href={`/api/whatsapp/download-batch/${batchNum}`}
                        download={`batch-${batchNum}.docx`}
                        data-testid={`link-download-batch-${batchNum}`}
                      >
                        <Button variant="outline" size="sm" className="gap-1.5">
                          <Download className="w-3.5 h-3.5" />
                          الدفعة {batchNum}
                        </Button>
                      </a>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">كل دفعة تحتوي على 1000 رابط مفحوص</p>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* ── Step: Results ── */}
        {step === "results" && session && (
          <div className="space-y-5">
            {/* Overall stats */}
            <div className="grid grid-cols-3 gap-4">
              <StatBox color="green" icon={<CheckCircle2 className="w-5 h-5" />} label="صالحة" value={validCount} large />
              <StatBox color="red" icon={<XCircle className="w-5 h-5" />} label="منتهية" value={invalidCount} large />
              <StatBox color="orange" icon={<AlertCircle className="w-5 h-5" />} label="أخطاء" value={errorCount} large />
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

            {/* Description links info + download */}
            {filteredSummary && filteredSummary.descriptionLinks > 0 && (
              <Card className="border-blue-200 dark:border-blue-900/40 bg-blue-50/50 dark:bg-blue-900/10">
                <CardContent className="pt-4 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
                    <Link2 className="w-4 h-4 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">روابط من الأوصاف</p>
                    <p className="text-xs text-muted-foreground">تم استخراج {filteredSummary.descriptionLinks} رابط من أوصاف المجموعات</p>
                  </div>
                  <Badge className="ml-1">{filteredSummary.descriptionLinks}</Badge>
                  <Button size="sm" variant="outline" className="flex-shrink-0"
                    onClick={() => window.open("/api/whatsapp/download-description-links", "_blank")}
                    data-testid="button-download-description-links">
                    <Download className="w-3.5 h-3.5 ml-1.5" />
                    تحميل
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Telegram links download in results */}
            {linkCounts.telegram > 0 && (
              <Card className="border-blue-200 dark:border-blue-900/40">
                <CardContent className="pt-4 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
                    <SiTelegram className="w-4 h-4 text-blue-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold">روابط تيليغرام</p>
                    <p className="text-xs text-muted-foreground">تم استخراج {linkCounts.telegram} رابط تيليغرام من الملف</p>
                  </div>
                  <Button size="sm" variant="outline"
                    onClick={() => window.open("/api/download/telegram", "_blank")}
                    data-testid="button-download-telegram-results">
                    <Download className="w-3.5 h-3.5 ml-1.5" />
                    تحميل
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* ── 3 action buttons ── */}
            <div className="grid grid-cols-3 gap-3">
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
                onClick={() => { setShowExtraPanel(o => !o); if (!showExtraPanel) setExtraPanelMode("upload"); setShowFreshUpload(false); }}
                className={`flex-col h-16 gap-1 text-xs ${showExtraPanel ? "border-primary text-primary bg-primary/5" : ""}`}
                data-testid="button-upload-new-file">
                {showExtraPanel ? <ChevronUp className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                <span>رفع ملف جديد</span>
              </Button>
            </div>

            {/* ── Extra options panel (upload only — join moved to sidebar) ── */}
            {showExtraPanel && (
              <Card className="border-primary/30">
                <CardContent className="pt-4 pb-4 space-y-3">
                  {/* Choice row: new round vs fresh session */}
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      className={`border rounded-lg p-3 text-right transition-colors ${extraPanelMode === "upload" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
                      onClick={() => setExtraPanelMode("upload")}
                      data-testid="option-new-round">
                      <div className="flex items-center gap-2 mb-1">
                        <FolderOpen className="w-4 h-4 text-primary flex-shrink-0" />
                        <span className="text-sm font-medium">جولة جديدة</span>
                      </div>
                      <p className="text-xs text-muted-foreground">روابط جديدة — يُزيل المكررة، يحتفظ بالجلسة</p>
                    </button>
                    <button
                      className={`border rounded-lg p-3 text-right transition-colors ${extraPanelMode === "join" ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
                      onClick={() => setExtraPanelMode("join")}
                      data-testid="option-fresh-session">
                      <div className="flex items-center gap-2 mb-1">
                        <Upload className="w-4 h-4 text-primary flex-shrink-0" />
                        <span className="text-sm font-medium">جلسة منفصلة</span>
                      </div>
                      <p className="text-xs text-muted-foreground">ملف جديد كلياً — يمسح النتائج الحالية</p>
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
                          <input ref={newRoundFileRef} type="file" accept=".docx,.doc" multiple className="hidden"
                            onChange={(e) => { if (e.target.files?.length) handleNewRoundFiles(e.target.files); e.target.value = ""; }} data-testid="input-new-round-file" />
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

                  {/* Fresh session sub-panel */}
                  {extraPanelMode === "join" && (
                    <div className="space-y-3 border-t pt-3">
                      <div className="flex items-start gap-2 text-xs bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
                        <AlertCircle className="w-4 h-4 text-yellow-600 flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="font-medium text-yellow-700 dark:text-yellow-400">تنبيه: جلسة منفصلة</p>
                          <p className="text-yellow-600 dark:text-yellow-500 mt-0.5">سيتم مسح النتائج الحالية وبدء جلسة فحص جديدة كلياً</p>
                        </div>
                      </div>
                      <div
                        className={`border-2 border-dashed rounded-lg p-5 flex flex-col items-center gap-3 cursor-pointer transition-colors ${isFreshDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
                        onDragOver={(e) => { e.preventDefault(); setIsFreshDragging(true); }}
                        onDragLeave={() => setIsFreshDragging(false)}
                        onDrop={(e) => { e.preventDefault(); setIsFreshDragging(false); if (e.dataTransfer.files.length) handleFreshFiles(e.dataTransfer.files); }}
                        onClick={() => freshUploadRef.current?.click()}
                        data-testid="dropzone-fresh-session">
                        {freshUploadMutation.isPending ? (
                          <><Loader2 className="w-7 h-7 text-primary animate-spin" /><p className="text-sm text-muted-foreground">جاري المعالجة...</p></>
                        ) : (
                          <>
                            <Upload className={`w-7 h-7 ${isFreshDragging ? "text-primary" : "text-muted-foreground"}`} />
                            <p className="text-sm font-medium">اسحب ملف DOCX هنا</p>
                          </>
                        )}
                        <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); freshUploadRef.current?.click(); }} data-testid="button-select-fresh-file">
                          <FileText className="w-3.5 h-3.5 ml-1.5" />اختر ملفاً
                        </Button>
                        <input ref={freshUploadRef} type="file" accept=".docx,.doc" multiple className="hidden"
                          onChange={(e) => { if (e.target.files?.length) handleFreshFiles(e.target.files); e.target.value = ""; }} data-testid="input-fresh-file-extra" />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Recent results list */}
            {recentResults.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">آخر النتائج المفحوصة ({recentResults.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1 max-h-72 overflow-y-auto">
                    {[...recentResults].reverse().map((r, i) => (
                      <div key={i} className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0">
                        {r.status === "valid" && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />}
                        {r.status === "invalid" && <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                        {r.status === "error" && <AlertCircle className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />}
                        <div className="flex-1 min-w-0">
                          <span className="font-mono text-xs truncate block text-muted-foreground">{r.link}</span>
                          {r.name && <span className="text-xs font-medium">{r.name}{r.members !== undefined ? ` — ${r.members} عضو` : ""}</span>}
                        </div>
                        <Badge variant={r.status === "valid" ? "default" : "secondary"} className="text-xs flex-shrink-0">
                          {r.status === "valid" ? "صالح" : r.status === "invalid" ? "منتهٍ" : "خطأ"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
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

