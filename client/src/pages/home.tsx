import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Link, useLocation } from "wouter";
import {
  Upload, FileText, Download, CheckCircle2, XCircle, AlertCircle,
  Loader2, Wifi, WifiOff, LogOut, RefreshCw, Shield,
  Link2, QrCode, Hash, ArrowRight, ArrowLeft, Users, Megaphone,
  FolderOpen, PlusCircle, FileJson, History, ChevronDown,
  ChevronUp, UserPlus, Clock, CheckCheck, Trash2,
  Pause, Play, Square, Menu, X, MessageCircle, Send, LayoutDashboard,
  TrendingUp, Activity, Zap, BarChart2, AlertTriangle, Ban, Moon,
  CalendarClock, Timer, Plus,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
interface PhoneStat { phone: string; displayName: string; isActive: boolean; Pending: number; PendingReal: number; PendingForMe: number; Joined: number; Ignored: number; Left: number; }
interface RepoCounts { Pending: number; Joined: number; Ignored: number; Left: number; }
interface JoinProgress2 {
  status: "running" | "waiting" | "sleeping" | "cooldown" | "paused" | "done" | "stopped" | "error";
  total: number; processed: number; joined: number; ignored: number; failed: number; skipped_ads: number;
  currentLink?: string; stopReason?: string; startedAt?: string; completedAt?: string;
  windowNumber?: number;
  nextJoinAt?:   string;
  sleepUntil?:   string;
  cooldownUntil?: string;
  telemetry?: { avgLatencyMs: number; lastLatencyMs: number; cooldownActive: boolean; warning?: string; };
}
interface WindowRecord {
  windowNumber: number; slotsExecuted: number; joined: number; failed: number; ignored: number;
  startedAt: string; completedAt: string; durationMs: number; avgLatencyMs: number; hadCooldown: boolean;
}
interface TelemetryRes {
  report: { avgLatencyMs: number; lastLatencyMs: number; sampleCount: number; cooldownActive: boolean; cooldownUntil?: string; warning?: string; };
  windowHistory: WindowRecord[];
  joinProgress: JoinProgress2 | null;
}
interface LeaveQueueEntry { url: string; groupJid?: string; enqueuedAt: string; reason?: string; scheduledAt?: string; }
interface AdMessage { _id: string; text: string; mediaData?: string; mediaType?: "image" | "video" | "document"; mediaCaption?: string; mediaFilename?: string; createdAt: string; sentCount: number; lastSentAt?: string; }
interface PublishProgress {
  status: "running" | "done" | "stopped" | "paused" | "error" | "cooldown";
  total: number; processed: number; sent: number; failed: number;
  currentGroup?: string; startedAt: string; completedAt?: string;
}
interface ReaderStats {
  status: "running" | "stopped" | "paused" | "error";
  messagesReceived: number; messagesFromAds: number; linksFound: number; linksNew: number;
  startedAt: string; stoppedAt?: string; pausedAt?: string;
  totalMessages?: number; totalLinksFound?: number; totalLinksNew?: number;
}
interface ExcludedGroup { _id?: string; url: string; name?: string; addedAt: string; }
interface SleepConfig { startHour: number; startMin: number; durationHours: number; }
interface LeaveProgress {
  status: "running" | "done" | "stopped" | "paused" | "error";
  total: number; processed: number; left: number; failed: number;
  startedAt: string; completedAt?: string; currentLink?: string;
}
interface PublishSession {
  _id?: string; startedAt: string; completedAt: string;
  status: "done" | "stopped" | "error";
  total: number; processed: number; sent: number; failed: number; phone?: string;
}

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "رفع الملف" },
  { key: "links", label: "الروابط والاتصال" },
  { key: "checking", label: "الفحص" },
  { key: "results", label: "النتائج" },
];

type IntervalUnit = "seconds" | "minutes" | "hours" | "days" | "weeks";
interface PublishSchedule {
  _id: string; name: string; intervalValue: number; intervalUnit: IntervalUnit;
  enabled: boolean; nextRunAt: string; lastRunAt?: string; createdAt: string;
}
const UNIT_LABELS: Record<IntervalUnit, string> = {
  seconds: "ثانية", minutes: "دقيقة", hours: "ساعة", days: "يوم", weeks: "أسبوع",
};
function formatNextRun(dateStr: string): string {
  const diffMs = new Date(dateStr).getTime() - Date.now();
  if (diffMs <= 0) return "الآن";
  const s = Math.round(diffMs / 1000);
  if (s < 60) return `${s}ث`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}د`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}س`;
  return `${Math.round(h / 24)}ي`;
}

function wkHeaders(): Record<string, string> {
  const k = localStorage.getItem("workspace_key") ?? "";
  return k ? { "X-Workspace-Key": k } : {};
}

/** Extract all unique WhatsApp group links from any free-form text (handles messy paste) */
function extractBulkLinks(text: string): string[] {
  const re = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]+/g;
  const all = [...text.matchAll(re)].map(m => m[0].replace(/[.,;)>\]'"»«\s]+$/, "").trim());
  return [...new Set(all.filter(Boolean))];
}

/** Human-friendly join time estimate given a link count */
function joinTimeEstimate(count: number): { windows: number; totalMin: number; label: string } {
  const windows = Math.ceil(count / 4);
  const totalMin = windows * 10;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const label = h > 0 ? (m > 0 ? `${h}س ${m}د` : `${h}س`) : `${m}د`;
  return { windows, totalMin, label };
}

function openWithKey(path: string): void {
  const k = localStorage.getItem("workspace_key") ?? "";
  window.open(k ? `${path}?wk=${encodeURIComponent(k)}` : path, "_blank");
}

export default function Home() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
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
  const [showPublishHistory, setShowPublishHistory] = useState(false);
  const [showSchedulerPanel, setShowSchedulerPanel] = useState(false);
  const [schedName, setSchedName] = useState("");
  const [schedValue, setSchedValue] = useState("1");
  const [schedUnit, setSchedUnit] = useState<IntervalUnit>("hours");
  const [showReaderPanel, setShowReaderPanel] = useState(false);
  const [showLeavePanel, setShowLeavePanel] = useState(false);
  const [showTelemetryPanel, setShowTelemetryPanel] = useState(false);
  const [showManualUpload, setShowManualUpload] = useState(false);
  const [manualUploadResult, setManualUploadResult] = useState<{ total: number; added: number; duplicates: number } | null>(null);
  const [isManualUploading, setIsManualUploading] = useState(false);
  const manualUploadRef = useRef<HTMLInputElement>(null);
  const [showExcludedPanel, setShowExcludedPanel] = useState(false);
  const [showPendingApprovalPanel, setShowPendingApprovalPanel] = useState(false);
  const [newExcludedUrl, setNewExcludedUrl] = useState("");
  const [sleepStartTime, setSleepStartTime] = useState("01:30");
  const [sleepConfigSaved, setSleepConfigSaved] = useState(false);
  const [leaveProgress, setLeaveProgress] = useState<LeaveProgress | null>(null);
  const sleepConfigInitRef = useRef(false);

  // ── Network health ────────────────────────────────────────────────────────
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up   = () => setIsOnline(true);
    const down = () => setIsOnline(false);
    window.addEventListener("online",  up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  const [newAdText, setNewAdText] = useState("");
  const [newAdMedia, setNewAdMedia] = useState<File | null>(null);
  const [newAdCaption, setNewAdCaption] = useState("");
  const adMediaRef = useRef<HTMLInputElement>(null);
  const [showBulkPaste, setShowBulkPaste] = useState(true);
  const [bulkPasteText, setBulkPasteText] = useState("");
  const [joinMaxLinks, setJoinMaxLinks] = useState<string>("");
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
  const { data: phoneStatsData, refetch: refetchPhoneStats } = useQuery<{ phones: PhoneStat[] }>({
    queryKey: ["/api/join/phone-stats"],
    refetchInterval: coordinatorData?.active === "joining" ? 5000 : 30000,
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
  const { data: publishHistoryData, refetch: refetchPublishHistory } = useQuery<{ sessions: PublishSession[] }>({
    queryKey: ["/api/publisher/history"],
    enabled: showPublishHistory,
    refetchInterval: false,
  });
  const { data: publisherProgressData } = useQuery<{ progress: PublishProgress | null }>({
    queryKey: ["/api/publisher/progress"],
    refetchInterval: coordinatorData?.active === "publishing" ? 2000 : false,
  });
  const { data: readerStatsData } = useQuery<{ stats: ReaderStats | null; isRunning: boolean; isPaused: boolean }>({
    queryKey: ["/api/reader/stats"],
    refetchInterval: 5000,
  });
  const { data: excludedGroupsData, refetch: refetchExcludedGroups } = useQuery<{ groups: ExcludedGroup[] }>({
    queryKey: ["/api/excluded-groups"],
    refetchInterval: false,
    enabled: showExcludedPanel,
  });
  const { data: pendingApprovalData, refetch: refetchPendingApproval } = useQuery<any[]>({
    queryKey: ["/api/links-repository/pending-approval"],
    refetchInterval: showPendingApprovalPanel ? 30000 : false,
    enabled: showPendingApprovalPanel,
  });
  const { data: sleepConfigData, refetch: refetchSleepConfig } = useQuery<SleepConfig & { durationHours: number }>({
    queryKey: ["/api/settings/sleep"],
    refetchInterval: false,
  });

  const { data: telemetryData } = useQuery<TelemetryRes>({
    queryKey: ["/api/telemetry"],
    refetchInterval: showTelemetryPanel || coordinatorData?.active === "joining" ? 3000 : 30000,
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

  // Sync sleep start time from server config once loaded
  useEffect(() => {
    if (sleepConfigInitRef.current || !sleepConfigData) return;
    sleepConfigInitRef.current = true;
    const h = String(sleepConfigData.startHour).padStart(2, "0");
    const m = String(sleepConfigData.startMin).padStart(2, "0");
    setSleepStartTime(`${h}:${m}`);
  }, [sleepConfigData]);

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
      const res = await fetch("/api/upload", { method: "POST", body: fd, headers: wkHeaders() });
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
      const res = await fetch("/api/upload-multiple", { method: "POST", body: fd, headers: wkHeaders() });
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
      const res = await fetch("/api/upload-new-round", { method: "POST", body: fd, headers: wkHeaders() });
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
      const res = await fetch("/api/upload-fresh", { method: "POST", body: fd, headers: wkHeaders() });
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

  const reconnectSessionMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/sessions/${id}/reconnect`, {}),
    onSuccess: () => { setIsConnecting(true); qc.invalidateQueries({ queryKey: ["/api/whatsapp/status"] }); },
    onError: (err: any) => toast({ title: "فشل إعادة الاتصال", description: err.message, variant: "destructive" }),
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
    mutationFn: () => apiRequest("POST", "/api/whatsapp/check/retry-errors", {}).then(r => r.json()),
    onSuccess: (data: any) => {
      setStep("checking");
      toast({ title: `إعادة فحص ${data?.retrying ?? 0} رابط بها أخطاء` });
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

  // "reading" can be preempted — only block other buttons for non-reading active functions
  const isCoordinatorBusy = (coordinatorData?.isRunning ?? false) && coordinatorData?.active !== "reading";
  const activeFunction = coordinatorData?.active ?? null;
  const joinProgress2 = joinProgress2Data?.progress ?? null;
  const join2Pct = joinProgress2 ? Math.round((joinProgress2.processed / Math.max(1, joinProgress2.total)) * 100) : 0;
  const publishProgress = publisherProgressData?.progress ?? null;
  const publishPct = publishProgress ? Math.round((publishProgress.processed / Math.max(1, publishProgress.total)) * 100) : 0;
  const readerStats = readerStatsData?.stats ?? null;
  const isReaderRunning = readerStatsData?.isRunning ?? false;
  const leaveQueue = leaveQueueData?.queue ?? [];

  const resetJoinForNewAccountMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/join/reset-for-new-account", {}).then(r => r.json()),
    onSuccess: (data: any) => {
      const count = data?.resetCount ?? 0;
      toast({ title: `تمت إعادة التعيين — ${count} رابط جاهز للحساب الجديد` });
      void refetchRepoCounts();
      void refetchJoinProgress2();
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const startJoin2Mutation = useMutation({
    mutationFn: () => {
      const max = parseInt(joinMaxLinks, 10);
      return apiRequest("POST", "/api/join/start", max > 0 ? { maxLinks: max } : {});
    },
    onSuccess: () => {
      const max = parseInt(joinMaxLinks, 10);
      toast({ title: max > 0 ? `بدأ الانضمام التجريبي — ${max} روابط فقط` : "بدأ الانضمام — 4 روابط كل 10 دقائق" });
      void refetchJoinProgress2();
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const stopJoin2Mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/join/stop", {}),
    onSuccess: () => { toast({ title: "تم إيقاف الانضمام" }); void refetchJoinProgress2(); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const pauseJoin2Mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/join/pause", {}),
    onSuccess: () => { toast({ title: "تم إيقاف الانضمام مؤقتاً" }); void refetchJoinProgress2(); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const resumeJoin2Mutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/join/resume", {}),
    onSuccess: () => { toast({ title: "تم استئناف الانضمام" }); void refetchJoinProgress2(); },
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
    mutationFn: async (params: { text: string; media?: File | null; caption?: string }) => {
      const { text, media, caption } = params;
      if (media) {
        const fd = new FormData();
        if (text) fd.append("text", text);
        fd.append("media", media);
        if (caption) fd.append("caption", caption);
        const key = localStorage.getItem("workspace_key") ?? "";
        const hdrs: Record<string, string> = {};
        if (key) hdrs["X-Workspace-Key"] = key;
        const r = await fetch("/api/publisher/ads", { method: "POST", body: fd, headers: hdrs, credentials: "include" });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      }
      return apiRequest("POST", "/api/publisher/ads", { text }).then(r => r.json());
    },
    onSuccess: () => { setNewAdText(""); setNewAdMedia(null); setNewAdCaption(""); void refetchPublisherAds(); toast({ title: "تمت إضافة الإعلان" }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const removeAdMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/publisher/ads/${id}`, {}),
    onSuccess: () => { void refetchPublisherAds(); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const leaveNowMutation = useMutation({
    mutationFn: (url: string) => apiRequest("POST", "/api/leave/leave-now", { url }),
    onSuccess: () => { toast({ title: "تمت المغادرة الفورية" }); void refetchLeaveQueue(); },
    onError: (err: any) => toast({ title: "خطأ في المغادرة الفورية", description: err.message, variant: "destructive" }),
  });
  const updateScheduleMutation = useMutation({
    mutationFn: ({ url, scheduledAt }: { url: string; scheduledAt: string | null }) =>
      apiRequest("PUT", "/api/leave/schedule", { url, scheduledAt }),
    onSuccess: () => { void refetchLeaveQueue(); toast({ title: "تم حفظ الموعد المجدول" }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const bulkPasteMutation = useMutation({
    mutationFn: (urls: string[]) => apiRequest("POST", "/api/links-repository/bulk-paste", { urls }).then(r => r.json()),
    onSuccess: (data: any) => {
      toast({ title: `تمت إضافة ${data.added} رابط جديد`, description: `مكرر: ${data.duplicates}، غير صالح: ${data.invalid}` });
      setBulkPasteText("");
      setShowBulkPaste(false);
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const syncGroupsMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/whatsapp/sync-groups", {}).then(r => r.json()),
    onSuccess: (data: any) => toast({
      title: "تمت مزامنة المجموعات",
      description: [
        data?.inserted  ? `${data.inserted} مجموعة جديدة أُضيفت` : "",
        data?.updated   ? `${data.updated} مجموعة حُدِّثت` : "",
        data?.markedLeft ? `${data.markedLeft} مجموعة علامة مغادرة` : "",
      ].filter(Boolean).join(" — ") || "لا تغييرات",
    }),
    onError: (err: any) => toast({ title: "خطأ في المزامنة", description: err.message, variant: "destructive" }),
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
  const pauseReaderMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/reader/pause", {}),
    onSuccess: () => { toast({ title: "تم تعليق القراءة مؤقتاً" }); qc.invalidateQueries({ queryKey: ["/api/reader/stats"] }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const resumeReaderMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/reader/resume", {}),
    onSuccess: () => { toast({ title: "تم استئناف القراءة" }); qc.invalidateQueries({ queryKey: ["/api/reader/stats"] }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const { data: schedulesData, isLoading: schedulesLoading } = useQuery<{ schedules: PublishSchedule[] }>({
    queryKey: ["/api/publisher/schedules"],
    queryFn: async () => {
      const k = localStorage.getItem("workspace_key") ?? "";
      const res = await fetch("/api/publisher/schedules", { credentials: "include", headers: k ? { "X-Workspace-Key": k } : {} });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    refetchInterval: showSchedulerPanel ? 8_000 : false,
    enabled: showSchedulerPanel,
    retry: 1,
  });

  const createScheduleMutation = useMutation({
    mutationFn: async (body: { name: string; intervalValue: number; intervalUnit: IntervalUnit }) => {
      const k = localStorage.getItem("workspace_key") ?? "";
      const res = await fetch("/api/publisher/schedules", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", ...(k ? { "X-Workspace-Key": k } : {}) },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/publisher/schedules"] });
      setSchedName(""); setSchedValue("1"); setSchedUnit("hours");
      toast({ title: "تم إنشاء الجدول" });
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const toggleScheduleMutation = useMutation({
    mutationFn: async (id: string) => {
      const k = localStorage.getItem("workspace_key") ?? "";
      const res = await fetch(`/api/publisher/schedules/${id}/toggle`, {
        method: "PATCH", credentials: "include",
        headers: k ? { "X-Workspace-Key": k } : {},
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/publisher/schedules"] }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const deleteScheduleMutation = useMutation({
    mutationFn: async (id: string) => {
      const k = localStorage.getItem("workspace_key") ?? "";
      const res = await fetch(`/api/publisher/schedules/${id}`, {
        method: "DELETE", credentials: "include",
        headers: k ? { "X-Workspace-Key": k } : {},
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/publisher/schedules"] }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const pauseLeaveMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/leave/pause", {}),
    onSuccess: () => toast({ title: "تم تعليق المغادرة مؤقتاً" }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const resumeLeaveMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/leave/resume", {}),
    onSuccess: () => toast({ title: "تم استئناف المغادرة" }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const pausePublishMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/publisher/pause", {}),
    onSuccess: () => toast({ title: "تم تعليق النشر مؤقتاً" }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const resumePublishMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/publisher/resume", {}),
    onSuccess: () => toast({ title: "تم استئناف النشر" }),
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const retryApprovalMutation = useMutation({
    mutationFn: (url: string) => apiRequest("POST", "/api/links-repository/retry-approval", { url }),
    onSuccess: () => { void refetchPendingApproval(); toast({ title: "تمت إعادة الإضافة للقائمة" }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const retryApprovalAllMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/links-repository/retry-approval-all", {}).then(r => r.json()),
    onSuccess: (data: any) => { void refetchPendingApproval(); toast({ title: `تمت إعادة ${data?.count ?? 0} رابط للقائمة` }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const addExcludedMutation = useMutation({
    mutationFn: (url: string) => apiRequest("POST", "/api/excluded-groups", { url }),
    onSuccess: () => { setNewExcludedUrl(""); void refetchExcludedGroups(); toast({ title: "تمت إضافة الرابط للمستثنيات" }); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });
  const removeExcludedMutation = useMutation({
    mutationFn: (url: string) => apiRequest("DELETE", "/api/excluded-groups", { url }),
    onSuccess: () => { void refetchExcludedGroups(); },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const saveSleepConfigMutation = useMutation({
    mutationFn: () => {
      const [h, m] = sleepStartTime.split(":").map(Number);
      return apiRequest("POST", "/api/settings/sleep", { startHour: h, startMin: m });
    },
    onSuccess: () => {
      setSleepConfigSaved(true);
      setTimeout(() => setSleepConfigSaved(false), 2000);
      void refetchSleepConfig();
      toast({ title: "تم حفظ وقت النوم" });
    },
    onError: (err: any) => toast({ title: "خطأ", description: err.message, variant: "destructive" }),
  });

  const currentStepIdx = STEPS.findIndex((s) => s.key === step);

  // ── Browser notification system ───────────────────────────────────────────
  const notifPermRef = useRef<NotificationPermission>("default");
  const prevJoinStatusRef   = useRef<string | null>(null);
  const prevWindowNumRef    = useRef<number>(0);
  const prevCooldownRef     = useRef<boolean>(false);
  const prevPublishStatusRef = useRef<string | null>(null);

  // Sync current permission state on mount WITHOUT auto-requesting
  // (browsers block auto-prompts; permission is requested on explicit user action)
  useEffect(() => {
    if ("Notification" in window) {
      notifPermRef.current = Notification.permission;
    }
  }, []);

  /** Call this on an explicit user gesture (e.g. "Start Bot") to request permission */
  function requestNotifPermIfNeeded() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().then(p => { notifPermRef.current = p; });
    } else {
      notifPermRef.current = Notification.permission;
    }
  }

  function sendNotif(title: string, body: string, icon = "/favicon.ico") {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    try { new Notification(title, { body, icon, dir: "rtl", lang: "ar" }); }
    catch {}
  }

  // Watch join progress for notification triggers
  useEffect(() => {
    if (!joinProgress2) return;
    const prev = prevJoinStatusRef.current;
    const prevWin = prevWindowNumRef.current;
    const prevCool = prevCooldownRef.current;

    // Cooldown just activated
    if (!prevCool && joinProgress2.telemetry?.cooldownActive) {
      sendNotif("🛡️ تبريد وقائي مفعّل", "تم رصد استجابة بطيئة — جاري الانتظار لحماية الحساب");
    }
    prevCooldownRef.current = !!joinProgress2.telemetry?.cooldownActive;

    // New window completed (windowNumber increased means last window finished)
    if ((joinProgress2.windowNumber ?? 0) > prevWin && prevWin > 0) {
      const joined = joinProgress2.joined;
      sendNotif(
        `✅ نافذة ${prevWin} اكتملت`,
        `تم الانضمام إلى ${joined} مجموعة حتى الآن — الانضمام القادم في ${
          joinProgress2.nextJoinAt
            ? new Date(joinProgress2.nextJoinAt).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })
            : "قريباً"
        }`
      );
    }
    prevWindowNumRef.current = joinProgress2.windowNumber ?? 0;

    // Session done
    if (prev && prev !== "done" && joinProgress2.status === "done") {
      sendNotif(
        "🎉 الانضمام اكتمل!",
        `ناجح: ${joinProgress2.joined} | فشل: ${joinProgress2.failed} | متجاهل: ${joinProgress2.ignored}`
      );
    }

    // Session stopped unexpectedly (stop_all from error)
    if (prev && prev !== "stopped" && joinProgress2.status === "stopped" && joinProgress2.stopReason?.includes("⚠️")) {
      sendNotif("⚠️ توقف طارئ في الانضمام", joinProgress2.stopReason ?? "يُرجى مراجعة التطبيق");
    }

    // Sleeping mode
    if (prev !== "sleeping" && joinProgress2.status === "sleeping") {
      sendNotif(
        "🌙 وضع النوم الليلي",
        `الانضمام متوقف حتى الساعة 7:30 صباحاً — كل شيء بأمان`
      );
    }

    prevJoinStatusRef.current = joinProgress2.status;
  }, [joinProgress2]);

  // Watch publisher for completion notification
  useEffect(() => {
    if (!publishProgress) return;
    const prev = prevPublishStatusRef.current;
    if (prev && prev !== "done" && publishProgress.status === "done") {
      sendNotif(
        "📢 النشر اكتمل",
        `أُرسل إلى ${publishProgress.sent} مجموعة — فشل: ${publishProgress.failed}`
      );
    }
    prevPublishStatusRef.current = publishProgress.status;
  }, [publishProgress]);

  const canNavigateTo = (target: Step): boolean => {
    if (target === step) return false;
    const hasLinks = linkCounts.whatsapp > 0 || linkCounts.telegram > 0;
    switch (target) {
      case "upload": return true;
      case "links": return true;
      case "checking": return !!session || hasLinks;
      case "results": return !!session || !!(previousResults?.hasPreviousSession);
      default: return false;
    }
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl">

      {/* ── Network offline banner ── */}
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-destructive text-destructive-foreground text-xs text-center py-2 flex items-center justify-center gap-2 shadow-md">
          <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
          <span>لا يوجد اتصال بالإنترنت — كل العمليات مؤقتة وستستأنف تلقائياً عند عودة الاتصال</span>
        </div>
      )}

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
                      {(sess.status === "disconnected" || sess.status === "auth_failed") && (
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 hover:bg-primary/10" title="إعادة الاتصال"
                          onClick={() => reconnectSessionMutation.mutate(sess.id)}
                          disabled={reconnectSessionMutation.isPending}
                          data-testid={`sidebar-reconnect-${sess.id}`}>
                          <RefreshCw className="w-3 h-3 text-primary" />
                        </Button>
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
                onClick={() => createSessionMutation.mutate(undefined, {
                  onSuccess: () => {
                    setSidebarOpen(false);
                    setStep("links");
                  }
                })}
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

                  {/* ── Active session (running / waiting / sleeping / cooldown / paused) ── */}
                  {joinProgress2 && ["running","waiting","sleeping","cooldown","paused"].includes(joinProgress2.status) && (
                    <div className="space-y-2">

                      {/* Status badge row */}
                      <div className="flex items-center justify-between">
                        {joinProgress2.status === "running" && (
                          <span className="text-xs font-medium flex items-center gap-1.5">
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />جاري الانضمام...
                          </span>
                        )}
                        {joinProgress2.status === "waiting" && (
                          <span className="text-xs font-medium flex items-center gap-1.5 text-amber-600">
                            <Clock className="w-3.5 h-3.5" />انتظار الفترة الزمنية
                          </span>
                        )}
                        {joinProgress2.status === "sleeping" && (
                          <span className="text-xs font-medium flex items-center gap-1.5 text-blue-600">
                            <Clock className="w-3.5 h-3.5" />نوم ليلي حتى الـ 7:30 ص
                          </span>
                        )}
                        {joinProgress2.status === "cooldown" && (
                          <span className="text-xs font-medium flex items-center gap-1.5 text-orange-600">
                            <Shield className="w-3.5 h-3.5" />تبريد وقائي
                          </span>
                        )}
                        {joinProgress2.status === "paused" && (
                          <span className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
                            <Pause className="w-3.5 h-3.5" />متوقف مؤقتاً
                          </span>
                        )}
                        <div className="flex items-center gap-1.5">
                          {joinProgress2.windowNumber != null && joinProgress2.windowNumber > 0 && (
                            <Badge variant="outline" className="text-[10px]">نافذة {joinProgress2.windowNumber}</Badge>
                          )}
                          <Badge variant="outline" className="text-xs">{joinProgress2.processed}/{joinProgress2.total}</Badge>
                        </div>
                      </div>

                      {/* Progress bar */}
                      <Progress value={join2Pct} className="h-1.5" />

                      {/* Stats grid */}
                      <div className="grid grid-cols-3 gap-1 text-center text-[10px]">
                        <div className="bg-green-50 dark:bg-green-900/20 rounded p-1.5">
                          <p className="font-bold text-green-600">{joinProgress2.joined}</p>
                          <p className="text-muted-foreground">ناجح</p>
                        </div>
                        <div className="bg-red-50 dark:bg-red-900/20 rounded p-1.5">
                          <p className="font-bold text-red-600">{joinProgress2.failed}</p>
                          <p className="text-muted-foreground">فشل</p>
                        </div>
                        <div className="bg-muted rounded p-1.5">
                          <p className="font-bold">{joinProgress2.ignored}</p>
                          <p className="text-muted-foreground">متجاهل</p>
                        </div>
                      </div>

                      {/* Current link */}
                      {joinProgress2.currentLink && (
                        <p className="text-[10px] text-muted-foreground font-mono truncate bg-muted rounded px-2 py-1">
                          {joinProgress2.currentLink}
                        </p>
                      )}

                      {/* Next join time */}
                      {joinProgress2.nextJoinAt && joinProgress2.status !== "running" && (
                        <div className="flex items-center gap-1.5 text-[10px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded px-2 py-1.5">
                          <Clock className="w-3 h-3 flex-shrink-0" />
                          <span>الانضمام القادم: {new Date(joinProgress2.nextJoinAt).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                        </div>
                      )}

                      {/* Sleep mode indicator */}
                      {joinProgress2.status === "sleeping" && joinProgress2.sleepUntil && (
                        <div className="flex items-center gap-1.5 text-[10px] text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 rounded px-2 py-1.5">
                          <Clock className="w-3 h-3 flex-shrink-0" />
                          <span>نوم حتى: {new Date(joinProgress2.sleepUntil).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" })}</span>
                        </div>
                      )}

                      {/* Telemetry warning */}
                      {joinProgress2.telemetry?.warning && (
                        <div className="flex items-start gap-1.5 text-[10px] text-orange-700 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 rounded px-2 py-1.5">
                          <Shield className="w-3 h-3 flex-shrink-0 mt-0.5" />
                          <span>{joinProgress2.telemetry.warning}</span>
                        </div>
                      )}

                      {/* Stop reason */}
                      {joinProgress2.stopReason && (
                        <p className="text-[10px] text-destructive bg-destructive/10 rounded p-1.5">
                          {joinProgress2.stopReason}
                        </p>
                      )}

                      {/* Pause / Resume + Stop buttons */}
                      <div className="flex gap-1.5">
                        {joinProgress2.status === "paused" ? (
                          <Button size="sm" variant="outline"
                            className="flex-1 text-xs h-8 border-primary/50 text-primary hover:bg-primary/5"
                            onClick={() => resumeJoin2Mutation.mutate()}
                            disabled={resumeJoin2Mutation.isPending}>
                            <Play className="w-3 h-3 ml-1" />استئناف
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline"
                            className="flex-1 text-xs h-8 border-amber-500/50 text-amber-600 hover:bg-amber-50"
                            onClick={() => pauseJoin2Mutation.mutate()}
                            disabled={pauseJoin2Mutation.isPending}>
                            <Pause className="w-3 h-3 ml-1" />تعليق
                          </Button>
                        )}
                        <Button size="sm" variant="outline"
                          className="flex-1 text-xs h-8 border-destructive/50 text-destructive hover:bg-destructive/5"
                          onClick={() => stopJoin2Mutation.mutate()}
                          disabled={stopJoin2Mutation.isPending}>
                          <Square className="w-3 h-3 ml-1" />إيقاف
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* ── Session ended ── */}
                  {(joinProgress2?.status === "done" || joinProgress2?.status === "stopped") && (
                    <div className="flex items-center gap-1.5 text-xs bg-green-50 dark:bg-green-900/20 rounded p-2 border border-green-200 dark:border-green-800">
                      <CheckCheck className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
                      <span className="text-green-700 dark:text-green-400 font-medium">
                        اكتمل — {joinProgress2.joined} ناجح، {joinProgress2.failed} فشل، {joinProgress2.ignored} متجاهل
                      </span>
                    </div>
                  )}

                  {/* ── Start section (idle / done / stopped) ── */}
                  {(!joinProgress2 || joinProgress2.status === "done" || joinProgress2.status === "stopped") && (
                    <div className="space-y-2">
                      {/* Max links input */}
                      <div>
                        <label className="text-[10px] text-muted-foreground block mb-1">عدد الروابط للانضمام</label>
                        <Input
                          type="number"
                          min={1}
                          max={9999}
                          placeholder="فارغ = كل الروابط المعلقة"
                          value={joinMaxLinks}
                          onChange={e => setJoinMaxLinks(e.target.value)}
                          className="h-8 text-xs text-right"
                          data-testid="input-join-max-links"
                        />
                      </div>
                      {/* Time distribution estimator */}
                      {joinMaxLinks && parseInt(joinMaxLinks) > 0 && (() => {
                        const count = parseInt(joinMaxLinks);
                        const { windows, label } = joinTimeEstimate(count);
                        return (
                          <div className="rounded-lg border border-primary/20 bg-primary/5 p-2 space-y-1.5 text-[10px]" data-testid="join-time-estimate">
                            <p className="font-semibold text-primary text-center text-[11px]">توزيع الوقت التقديري</p>
                            <div className="grid grid-cols-3 gap-1 text-center">
                              <div className="bg-background rounded p-1.5 border border-border">
                                <p className="font-bold text-sm">{count}</p>
                                <p className="text-muted-foreground">رابط</p>
                              </div>
                              <div className="bg-background rounded p-1.5 border border-border">
                                <p className="font-bold text-sm">{windows}</p>
                                <p className="text-muted-foreground">نافذة × 10د</p>
                              </div>
                              <div className="bg-background rounded p-1.5 border border-primary/30">
                                <p className="font-bold text-sm text-primary">{label}</p>
                                <p className="text-muted-foreground">إجمالي</p>
                              </div>
                            </div>
                            <p className="text-center text-muted-foreground">4 روابط / نافذة · التوقيت عشوائي داخل كل نافذة</p>
                          </div>
                        );
                      })()}
                      <Button size="sm" className="w-full text-xs h-8"
                        onClick={() => { requestNotifPermIfNeeded(); startJoin2Mutation.mutate(); }}
                        disabled={startJoin2Mutation.isPending || waStatus !== "connected" || isCoordinatorBusy}
                        data-testid="sidebar-start-join2">
                        {startJoin2Mutation.isPending
                          ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" />
                          : <UserPlus className="w-3.5 h-3.5 ml-1" />}
                        {joinMaxLinks && parseInt(joinMaxLinks) > 0 ? `بدء الانضمام (${joinMaxLinks} رابط)` : "بدء الانضمام — كل الروابط"}
                      </Button>
                    </div>
                  )}

                  {/* ── Rate info ── */}
                  <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground bg-muted/50 rounded p-2">
                    <Shield className="w-3 h-3 flex-shrink-0 mt-0.5" />
                    <span>معدل آمن: 4 روابط كل 10 دقائق — نوم 1:30 ص – 7:30 ص — تبريد تلقائي عند أي إشارة خطر — إيقاف/استئناف تلقائي عند انقطاع واتساب</span>
                  </div>
                  {/* Note about Stop vs WhatsApp connection */}
                  <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground bg-blue-50 dark:bg-blue-900/20 rounded p-2">
                    <Shield className="w-3 h-3 flex-shrink-0 mt-0.5 text-blue-500" />
                    <span className="text-blue-700 dark:text-blue-400">ملاحظة: زر الإيقاف يوقف جلسة الانضمام فقط — اتصال واتساب يبقى نشطاً</span>
                  </div>

                  {/* ── New account reset ── */}
                  <div className="border-t border-border pt-2 mt-1">
                    <p className="text-[10px] text-muted-foreground mb-1.5">حساب واتساب جديد؟ أعد تعيين الروابط المنضم إليها بالحساب السابق:</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-xs h-8 border-orange-400/60 text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-900/20"
                      onClick={() => resetJoinForNewAccountMutation.mutate()}
                      disabled={resetJoinForNewAccountMutation.isPending || waStatus !== "connected"}
                      data-testid="button-reset-join-for-new-account"
                    >
                      {resetJoinForNewAccountMutation.isPending
                        ? <Loader2 className="w-3 h-3 ml-1 animate-spin" />
                        : <RefreshCw className="w-3 h-3 ml-1" />}
                      مزامنة مع الحساب الحالي
                    </Button>
                  </div>

                  {/* ── Pending admin-approval groups ── */}
                  <div className="border-t border-border pt-2 mt-1">
                    <Button variant="ghost" size="sm" className="w-full text-xs h-7 text-muted-foreground hover:text-foreground justify-between px-1"
                      onClick={() => { setShowPendingApprovalPanel(o => !o); if (!pendingApprovalData) void refetchPendingApproval(); }}
                      data-testid="button-toggle-pending-approval">
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3 text-yellow-500" />
                        <span>بانتظار قبول المشرف</span>
                      </div>
                      {showPendingApprovalPanel ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </Button>
                    {showPendingApprovalPanel && (
                      <div className="mt-1 space-y-1.5">
                        {!pendingApprovalData ? (
                          <div className="flex justify-center py-2"><Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" /></div>
                        ) : pendingApprovalData.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground text-center py-2">لا توجد مجموعات بانتظار القبول</p>
                        ) : (
                          <>
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-muted-foreground">{pendingApprovalData.length} مجموعة</span>
                              <Button size="sm" variant="outline"
                                className="h-5 px-2 text-[10px] border-yellow-400/60 text-yellow-700 dark:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-900/20"
                                onClick={() => retryApprovalAllMutation.mutate()}
                                disabled={retryApprovalAllMutation.isPending}
                                data-testid="button-retry-all-approval">
                                {retryApprovalAllMutation.isPending ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5 mr-0.5" />}
                                إعادة الكل
                              </Button>
                            </div>
                            <div className="max-h-40 overflow-y-auto space-y-1">
                              {pendingApprovalData.map((item: any) => (
                                <div key={item.url} className="flex items-center justify-between gap-1 bg-yellow-50/60 dark:bg-yellow-900/10 border border-yellow-200/60 dark:border-yellow-800/40 rounded p-1.5" data-testid={`pending-approval-${item._id}`}>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-[10px] font-medium truncate">{item.name ?? item.url}</p>
                                    <p className="text-[9px] text-muted-foreground truncate">{item.url}</p>
                                  </div>
                                  <Button size="sm" variant="ghost"
                                    className="h-5 w-5 p-0 flex-shrink-0 hover:bg-yellow-100 dark:hover:bg-yellow-800/30"
                                    onClick={() => retryApprovalMutation.mutate(item.url)}
                                    disabled={retryApprovalMutation.isPending}
                                    data-testid={`button-retry-approval-${item._id}`}>
                                    <RefreshCw className="w-2.5 h-2.5 text-yellow-600" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* ── Per-phone join stats ── */}
                  {phoneStatsData?.phones && phoneStatsData.phones.length > 0 && (
                    <div className="border-t border-border pt-2 mt-1 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">إحصائيات الأجهزة</p>
                        <button onClick={() => void refetchPhoneStats()} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                          <RefreshCw className="w-2.5 h-2.5" />
                        </button>
                      </div>
                      {phoneStatsData.phones.map((ps) => (
                        <div key={ps.phone} className={`rounded-lg border p-2 space-y-1.5 ${ps.isActive ? "border-primary/40 bg-primary/5" : "border-border bg-muted/20"}`}>
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[10px] font-medium text-foreground truncate">{ps.displayName}</span>
                            {ps.isActive && <Badge variant="default" className="text-[9px] px-1 py-0 h-4">نشط</Badge>}
                          </div>
                          {/* Row 1: joined + pending breakdown */}
                          <div className="grid grid-cols-3 gap-1 text-center">
                            <div className="bg-background rounded p-1 border">
                              <p className="font-bold text-[11px] text-green-600 leading-none">{ps.Joined}</p>
                              <p className="text-[8px] text-muted-foreground mt-0.5">منضم</p>
                            </div>
                            <div className="bg-background rounded p-1 border">
                              <p className="font-bold text-[11px] text-yellow-600 leading-none">{ps.PendingReal ?? ps.Pending}</p>
                              <p className="text-[8px] text-muted-foreground mt-0.5">معلق</p>
                            </div>
                            <div className="bg-background rounded p-1 border border-dashed border-yellow-400/60">
                              <p className="font-bold text-[11px] text-yellow-500 leading-none">{ps.PendingForMe ?? 0}</p>
                              <p className="text-[8px] text-muted-foreground mt-0.5">بانتظاري</p>
                            </div>
                          </div>
                          {/* Row 2: ignored + left */}
                          <div className="grid grid-cols-2 gap-1 text-center">
                            <div className="bg-background rounded p-1 border">
                              <p className="font-bold text-[11px] text-red-500 leading-none">{ps.Ignored}</p>
                              <p className="text-[8px] text-muted-foreground mt-0.5">متجاهل</p>
                            </div>
                            <div className="bg-background rounded p-1 border">
                              <p className="font-bold text-[11px] text-muted-foreground leading-none">{ps.Left}</p>
                              <p className="text-[8px] text-muted-foreground mt-0.5">خرج</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── وقت النوم ── */}
              <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-3 space-y-2 bg-blue-50/50 dark:bg-blue-900/10">
                <div className="flex items-center gap-1.5">
                  <Moon className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
                  <span className="text-xs font-medium text-blue-800 dark:text-blue-300">وقت النوم (6 ساعات)</span>
                  {sleepConfigData && (
                    <span className="mr-auto text-[10px] text-muted-foreground">
                      ينتهي {String((sleepConfigData.startHour + 6) % 24).padStart(2, "0")}:{String(sleepConfigData.startMin).padStart(2, "0")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    type="time"
                    value={sleepStartTime}
                    onChange={(e) => setSleepStartTime(e.target.value)}
                    className="flex-1 h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    data-testid="input-sleep-start"
                  />
                  <Button size="sm" className={`h-8 px-3 text-xs ${sleepConfigSaved ? "bg-green-500 hover:bg-green-600" : "bg-blue-600 hover:bg-blue-700"} text-white`}
                    onClick={() => saveSleepConfigMutation.mutate()}
                    disabled={saveSleepConfigMutation.isPending}
                    data-testid="button-save-sleep">
                    {saveSleepConfigMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : sleepConfigSaved ? <CheckCheck className="w-3.5 h-3.5" /> : "حفظ"}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">يتوقف الانضمام يومياً من الوقت المحدد لمدة 6 ساعات</p>
              </div>

              {/* ── لوحة التلميترى ── */}
              <Button variant="outline" className={`w-full justify-start gap-2 h-10 ${showTelemetryPanel ? "border-primary bg-primary/5" : ""}`}
                onClick={() => setShowTelemetryPanel(o => !o)}
                data-testid="sidebar-telemetry">
                <Activity className="w-4 h-4 text-primary flex-shrink-0" />
                <span className="flex-1 text-right text-sm">التلميترى والنوافذ</span>
                {telemetryData?.report.cooldownActive && <Badge className="text-[10px] bg-orange-500">تبريد</Badge>}
                {showTelemetryPanel ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </Button>
              {showTelemetryPanel && (
                <div className="border border-primary/20 rounded-lg p-3 space-y-3 bg-primary/5">
                  {/* ── Current latency / cooldown ── */}
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
                      <Zap className="w-3 h-3" />زمن الاستجابة
                    </p>
                    <div className="grid grid-cols-2 gap-1 text-[10px] text-center">
                      <div className="bg-background rounded p-1.5 border">
                        <p className="font-bold text-sm">{telemetryData?.report.avgLatencyMs ?? 0} <span className="text-[10px] font-normal">ms</span></p>
                        <p className="text-muted-foreground">متوسط</p>
                      </div>
                      <div className="bg-background rounded p-1.5 border">
                        <p className="font-bold text-sm">{telemetryData?.report.lastLatencyMs ?? 0} <span className="text-[10px] font-normal">ms</span></p>
                        <p className="text-muted-foreground">آخر قياس</p>
                      </div>
                    </div>
                    {telemetryData?.report.cooldownActive && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-400 rounded p-2 border border-orange-200 dark:border-orange-800">
                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                        <span>تبريد نشط حتى {telemetryData.report.cooldownUntil ? new Date(telemetryData.report.cooldownUntil).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
                      </div>
                    )}
                    {telemetryData?.report.warning && !telemetryData.report.cooldownActive && (
                      <p className="text-[10px] text-amber-600 mt-1 bg-amber-50 rounded p-1.5">{telemetryData.report.warning}</p>
                    )}
                  </div>

                  {/* ── Window history ── */}
                  {telemetryData?.windowHistory && telemetryData.windowHistory.length > 0 ? (
                    <div>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
                        <BarChart2 className="w-3 h-3" />آخر {Math.min(telemetryData.windowHistory.length, 10)} نوافذ
                      </p>
                      <div className="space-y-1">
                        {[...telemetryData.windowHistory].reverse().slice(0, 10).map((w) => (
                          <div key={w.windowNumber} className={`flex items-center gap-1.5 rounded p-1.5 text-[10px] border ${w.hadCooldown ? "bg-orange-50 dark:bg-orange-900/10 border-orange-200 dark:border-orange-800" : "bg-background border-border"}`}>
                            <span className="font-bold text-muted-foreground w-5 text-center">#{w.windowNumber}</span>
                            <div className="flex-1 grid grid-cols-3 gap-1 text-center">
                              <span className="text-green-600 font-bold">✓ {w.joined}</span>
                              <span className="text-destructive font-bold">✗ {w.failed}</span>
                              <span className="text-muted-foreground">{w.slotsExecuted} فتحات</span>
                            </div>
                            <span className="text-muted-foreground text-[9px] whitespace-nowrap">{Math.round(w.durationMs / 1000)}ث</span>
                            {w.hadCooldown && <AlertTriangle className="w-2.5 h-2.5 text-orange-500 flex-shrink-0" />}
                          </div>
                        ))}
                      </div>
                      <div className="mt-1.5 flex gap-2 text-[9px] text-muted-foreground border-t pt-1.5">
                        <span>إجمالي النوافذ: <b>{telemetryData.windowHistory.length}</b></span>
                        <span>·</span>
                        <span>إجمالي الانضمام: <b className="text-green-600">{telemetryData.windowHistory.reduce((a, w) => a + w.joined, 0)}</b></span>
                        <span>·</span>
                        <span>فشل: <b className="text-destructive">{telemetryData.windowHistory.reduce((a, w) => a + w.failed, 0)}</b></span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[10px] text-muted-foreground text-center py-2">لم تنتهِ أي نافذة بعد — ابدأ الانضمام لرؤية البيانات</p>
                  )}
                </div>
              )}

              {/* ── رفع روابط يدوي → MongoDB ── */}
              <Button variant="outline" className={`w-full justify-start gap-2 h-10 ${showManualUpload ? "border-primary bg-primary/5" : ""}`}
                onClick={() => { setShowManualUpload(o => !o); setManualUploadResult(null); }}
                data-testid="sidebar-manual-upload">
                <FolderOpen className="w-4 h-4 text-primary flex-shrink-0" />
                <span className="flex-1 text-right text-sm">رفع روابط مفلترة يدوياً</span>
                {showManualUpload ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </Button>
              {showManualUpload && (
                <div className="border border-primary/20 rounded-lg p-3 space-y-2 bg-primary/5">
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    ارفع ملف DOCX يحتوي على روابط واتساب — ستُضاف مباشرةً إلى قاعدة البيانات بحيث تستخدمها وظيفة الانضمام. الروابط المكررة تُتجاهل تلقائياً.
                  </p>
                  <input
                    ref={manualUploadRef}
                    type="file"
                    accept=".docx,.doc"
                    className="hidden"
                    data-testid="input-manual-upload"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      setIsManualUploading(true);
                      setManualUploadResult(null);
                      try {
                        const fd = new FormData();
                        fd.append("file", file);
                        const resp = await fetch("/api/links-repository/manual-upload", { method: "POST", body: fd, headers: wkHeaders() });
                        const data = await resp.json();
                        if (!resp.ok) throw new Error(data.error || "خطأ في الرفع");
                        setManualUploadResult(data);
                        void refetchRepoCounts();
                      } catch (err: any) {
                        toast({ title: "خطأ في الرفع", description: err.message, variant: "destructive" });
                      } finally {
                        setIsManualUploading(false);
                        if (manualUploadRef.current) manualUploadRef.current.value = "";
                      }
                    }}
                  />
                  <Button size="sm" className="w-full h-8 text-xs gap-1.5" disabled={isManualUploading}
                    onClick={() => manualUploadRef.current?.click()}
                    data-testid="button-manual-upload-pick">
                    {isManualUploading
                      ? <><Loader2 className="w-3 h-3 animate-spin" />جاري الرفع...</>
                      : <><PlusCircle className="w-3 h-3" />اختيار ملف DOCX</>}
                  </Button>
                  {manualUploadResult && (
                    <div className="grid grid-cols-3 gap-1 text-[10px] text-center mt-1">
                      <div className="bg-background rounded p-1.5 border">
                        <p className="font-bold text-sm">{manualUploadResult.total}</p>
                        <p className="text-muted-foreground">إجمالي</p>
                      </div>
                      <div className="bg-green-50 dark:bg-green-900/20 rounded p-1.5">
                        <p className="font-bold text-sm text-green-600">{manualUploadResult.added}</p>
                        <p className="text-muted-foreground">جديد</p>
                      </div>
                      <div className="bg-muted rounded p-1.5">
                        <p className="font-bold text-sm text-muted-foreground">{manualUploadResult.duplicates}</p>
                        <p className="text-muted-foreground">مكرر</p>
                      </div>
                    </div>
                  )}
                  {/* Bulk paste inside manual upload panel */}
                  <div className="border-t border-primary/20 pt-2 space-y-1.5">
                    <p className="text-[10px] text-muted-foreground font-medium">أو الصق الروابط مباشرة:</p>
                    <textarea
                      className="w-full h-20 text-[10px] font-mono rounded border bg-background p-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder={"https://chat.whatsapp.com/ABC123\nhttps://chat.whatsapp.com/DEF456"}
                      value={bulkPasteText}
                      onChange={(e) => setBulkPasteText(e.target.value)}
                      data-testid="textarea-bulk-paste-sidebar"
                    />
                    <Button size="sm" className="w-full h-7 text-xs gap-1"
                      onClick={() => {
                        const urls = bulkPasteText.split("\n").map(l => l.trim()).filter(Boolean);
                        if (urls.length) bulkPasteMutation.mutate(urls);
                      }}
                      disabled={bulkPasteMutation.isPending || !bulkPasteText.trim()}
                      data-testid="button-bulk-paste-sidebar">
                      {bulkPasteMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlusCircle className="w-3 h-3" />}
                      إضافة ({bulkPasteText.split("\n").filter(l => l.trim().includes("chat.whatsapp.com/")).length})
                    </Button>
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
                    <div className="space-y-1.5">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">الجلسة الحالية</p>
                      <div className="grid grid-cols-3 gap-1 text-center text-[10px]">
                        <div className="bg-background rounded p-1.5 border"><p className="font-bold text-sm">{readerStats.messagesReceived}</p><p className="text-muted-foreground">رسالة</p></div>
                        <div className="bg-orange-50 dark:bg-orange-900/20 rounded p-1.5"><p className="font-bold text-sm text-orange-600">{readerStats.messagesFromAds}</p><p className="text-muted-foreground">إعلانات</p></div>
                        <div className="bg-green-50 dark:bg-green-900/20 rounded p-1.5"><p className="font-bold text-sm text-green-600">{readerStats.linksNew}</p><p className="text-muted-foreground">جديدة</p></div>
                      </div>
                      {(readerStats.totalMessages !== undefined) && (
                        <>
                          <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold pt-0.5">الإجمالي التراكمي</p>
                          <div className="grid grid-cols-3 gap-1 text-center text-[10px]">
                            <div className="bg-blue-50/60 dark:bg-blue-900/10 rounded p-1.5 border border-blue-200/60 dark:border-blue-800/40">
                              <p className="font-bold text-sm text-blue-700 dark:text-blue-400">{(readerStats.totalMessages ?? 0) + readerStats.messagesReceived}</p>
                              <p className="text-muted-foreground">رسالة</p>
                            </div>
                            <div className="bg-blue-50/60 dark:bg-blue-900/10 rounded p-1.5 border border-blue-200/60 dark:border-blue-800/40">
                              <p className="font-bold text-sm text-blue-700 dark:text-blue-400">{(readerStats.totalLinksFound ?? 0) + readerStats.linksFound}</p>
                              <p className="text-muted-foreground">روابط</p>
                            </div>
                            <div className="bg-blue-50/60 dark:bg-blue-900/10 rounded p-1.5 border border-blue-200/60 dark:border-blue-800/40">
                              <p className="font-bold text-sm text-blue-700 dark:text-blue-400">{(readerStats.totalLinksNew ?? 0) + readerStats.linksNew}</p>
                              <p className="text-muted-foreground">جديدة</p>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {readerStats && (
                    <div className="flex items-center gap-1 text-[10px]">
                      <span className={`px-1.5 py-0.5 rounded-full font-medium ${readerStats.status === "running" ? "bg-green-100 text-green-700" : readerStats.status === "paused" ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-600"}`}>
                        {readerStats.status === "running" ? "● يعمل" : readerStats.status === "paused" ? "⏸ معلق" : "■ متوقف"}
                      </span>
                    </div>
                  )}
                  {isReaderRunning ? (
                    <div className="flex gap-1.5">
                      {readerStatsData?.isPaused ? (
                        <Button size="sm" variant="outline" className="flex-1 text-xs h-8 border-primary/50 text-primary" onClick={() => resumeReaderMutation.mutate()} disabled={resumeReaderMutation.isPending} data-testid="button-resume-reader">
                          <Play className="w-3 h-3 ml-1" />استئناف
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" className="flex-1 text-xs h-8 border-amber-500/50 text-amber-600 hover:bg-amber-50" onClick={() => pauseReaderMutation.mutate()} disabled={pauseReaderMutation.isPending} data-testid="button-pause-reader">
                          <Pause className="w-3 h-3 ml-1" />تعليق
                        </Button>
                      )}
                      <Button size="sm" variant="outline" className="flex-1 text-xs h-8 border-destructive/50 text-destructive" onClick={() => stopReaderMutation.mutate()} disabled={stopReaderMutation.isPending} data-testid="sidebar-stop-reader">
                        <Square className="w-3 h-3 ml-1" />إيقاف
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" className="w-full text-xs h-8"
                      onClick={() => startReaderMutation.mutate()}
                      disabled={startReaderMutation.isPending || waStatus !== "connected"}
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
                  {publishProgress && ["running","paused"].includes(publishProgress.status) && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1">
                          {publishProgress.status === "paused"
                            ? <><Pause className="w-3 h-3 text-amber-500" />معلق مؤقتاً</>
                            : <><Loader2 className="w-3 h-3 animate-spin text-orange-500" />جاري النشر...</>}
                        </span>
                        <Badge variant="outline">{publishProgress.processed}/{publishProgress.total}</Badge>
                      </div>
                      <Progress value={publishPct} className="h-1.5" />
                      <div className="grid grid-cols-2 gap-1 text-center text-[10px]">
                        <div className="bg-green-50 rounded p-1.5"><p className="font-bold text-green-600">{publishProgress.sent}</p><p className="text-muted-foreground">أُرسل</p></div>
                        <div className="bg-red-50 rounded p-1.5"><p className="font-bold text-red-600">{publishProgress.failed}</p><p className="text-muted-foreground">فشل</p></div>
                      </div>
                      <div className="flex gap-1.5">
                        {publishProgress.status === "paused" ? (
                          <Button size="sm" variant="outline" className="flex-1 text-xs h-8 border-primary/50 text-primary" onClick={() => resumePublishMutation.mutate()} disabled={resumePublishMutation.isPending} data-testid="button-resume-publish">
                            <Play className="w-3 h-3 ml-1" />استئناف
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" className="flex-1 text-xs h-8 border-amber-500/50 text-amber-600 hover:bg-amber-50" onClick={() => pausePublishMutation.mutate()} disabled={pausePublishMutation.isPending} data-testid="button-pause-publish">
                            <Pause className="w-3 h-3 ml-1" />تعليق
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="flex-1 text-xs h-8 border-destructive/50 text-destructive" onClick={() => stopPublishMutation.mutate()} disabled={stopPublishMutation.isPending} data-testid="button-stop-publish">
                          <Square className="w-3 h-3 ml-1" />إيقاف
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Excluded groups toggle */}
                  <Button variant="ghost" size="sm" className="w-full text-xs h-7 text-muted-foreground hover:text-foreground justify-start gap-1"
                    onClick={() => { setShowExcludedPanel(o => !o); if (!excludedGroupsData) void refetchExcludedGroups(); }}
                    data-testid="button-excluded-groups">
                    <Ban className="w-3 h-3 ml-1 text-destructive" />
                    {showExcludedPanel ? "إخفاء المستثنيين" : `مجموعات مستثناة (${excludedGroupsData?.groups.length ?? 0})`}
                    {showExcludedPanel ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
                  </Button>
                  {showExcludedPanel && (
                    <div className="border border-destructive/20 rounded-lg p-2.5 space-y-2 bg-destructive/5">
                      <p className="text-[10px] text-muted-foreground">المجموعات المضافة هنا لن تُرسَل لها إعلانات</p>
                      {excludedGroupsData && excludedGroupsData.groups.length > 0 && (
                        <div className="space-y-1 max-h-36 overflow-y-auto">
                          {excludedGroupsData.groups.map((g) => (
                            <div key={g.url} className="flex items-center gap-1.5 bg-background rounded p-1.5 border text-[10px]">
                              <span className="flex-1 font-mono truncate text-muted-foreground">{g.url}</span>
                              <Button size="sm" variant="ghost" className="h-5 w-5 p-0 flex-shrink-0" onClick={() => removeExcludedMutation.mutate(g.url)} disabled={removeExcludedMutation.isPending} data-testid={`button-remove-excluded-${g.url}`}><Trash2 className="w-3 h-3 text-destructive" /></Button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-1.5">
                        <Input placeholder="رابط المجموعة..." value={newExcludedUrl} onChange={(e) => setNewExcludedUrl(e.target.value)} className="flex-1 h-8 text-xs" onKeyDown={(e) => { if (e.key === "Enter" && newExcludedUrl.trim()) addExcludedMutation.mutate(newExcludedUrl.trim()); }} data-testid="input-excluded-url" />
                        <Button size="sm" className="h-8 px-2 bg-destructive hover:bg-destructive/90" onClick={() => addExcludedMutation.mutate(newExcludedUrl.trim())} disabled={addExcludedMutation.isPending || !newExcludedUrl.trim()} data-testid="button-add-excluded">
                          {addExcludedMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlusCircle className="w-3.5 h-3.5" />}
                        </Button>
                      </div>
                    </div>
                  )}
                  {/* Ad list */}
                  {publisherAdsData && publisherAdsData.length > 0 && (
                    <div className="space-y-1 max-h-44 overflow-y-auto">
                      {publisherAdsData.map((ad) => (
                        <div key={ad._id} className="flex items-start gap-1.5 bg-background rounded p-2 border text-xs">
                          <div className="flex-1 min-w-0">
                            {ad.mediaType && (
                              <div className="flex items-center gap-1 mb-1">
                                <Badge variant="secondary" className="text-[9px] h-4 px-1 gap-0.5">
                                  {ad.mediaType === "image" ? "🖼" : ad.mediaType === "video" ? "🎥" : "📄"}
                                  {ad.mediaFilename ? ad.mediaFilename.slice(0, 18) : ad.mediaType}
                                </Badge>
                              </div>
                            )}
                            <span className="line-clamp-2 text-muted-foreground">{ad.mediaCaption ?? ad.text}</span>
                          </div>
                          <div className="flex flex-col items-end gap-1 flex-shrink-0">
                            <Badge variant="outline" className="text-[9px] h-4 px-1">{ad.sentCount}×</Badge>
                            <Button size="sm" variant="ghost" className="h-5 w-5 p-0 hover:bg-destructive/10" onClick={() => removeAdMutation.mutate(ad._id)} disabled={removeAdMutation.isPending} data-testid={`button-remove-ad-${ad._id}`}><Trash2 className="w-3 h-3 text-destructive" /></Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Add ad */}
                  <div className="space-y-1.5">
                    {newAdMedia && (
                      <div className="flex items-center gap-1.5 bg-orange-50 dark:bg-orange-900/20 rounded p-1.5 border border-orange-200 dark:border-orange-800 text-xs">
                        <span className="flex-1 truncate text-orange-700 dark:text-orange-300">
                          {newAdMedia.type.startsWith("image/") ? "🖼" : newAdMedia.type.startsWith("video/") ? "🎥" : "📄"} {newAdMedia.name}
                        </span>
                        <Button size="sm" variant="ghost" className="h-5 w-5 p-0" onClick={() => setNewAdMedia(null)}><X className="w-3 h-3 text-orange-600" /></Button>
                      </div>
                    )}
                    {newAdMedia && (
                      <Input
                        placeholder="تعليق الوسائط (اختياري)..."
                        value={newAdCaption}
                        onChange={(e) => setNewAdCaption(e.target.value)}
                        className="h-8 text-xs"
                        data-testid="input-ad-caption"
                      />
                    )}
                    <div className="flex gap-1.5">
                      <Input
                        placeholder={newAdMedia ? "نص الإعلان (اختياري)..." : "نص الإعلان الجديد..."}
                        value={newAdText}
                        onChange={(e) => setNewAdText(e.target.value)}
                        className="flex-1 h-8 text-xs"
                        onKeyDown={(e) => { if (e.key === "Enter" && (newAdText.trim() || newAdMedia)) addAdMutation.mutate({ text: newAdText, media: newAdMedia, caption: newAdCaption }); }}
                        data-testid="input-new-ad"
                      />
                      <Button size="sm" variant="outline" className="h-8 px-2 border-orange-300 text-orange-600 hover:bg-orange-50 flex-shrink-0" onClick={() => adMediaRef.current?.click()} title="إرفاق صورة/فيديو/مستند" data-testid="button-attach-media">
                        <Plus className="w-3.5 h-3.5" />
                      </Button>
                      <input ref={adMediaRef} type="file" accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.zip" className="hidden"
                        onChange={(e) => { if (e.target.files?.[0]) { setNewAdMedia(e.target.files[0]); } e.target.value = ""; }}
                        data-testid="input-ad-media-file" />
                      <Button size="sm" className="h-8 px-2" onClick={() => addAdMutation.mutate({ text: newAdText, media: newAdMedia, caption: newAdCaption })} disabled={addAdMutation.isPending || (!newAdText.trim() && !newAdMedia)} data-testid="button-add-ad">
                        {addAdMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlusCircle className="w-3.5 h-3.5" />}
                      </Button>
                    </div>
                  </div>
                  {/* Sync groups from WhatsApp */}
                  <Button size="sm" variant="outline"
                    className="w-full text-xs h-8 border-blue-400/60 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    onClick={() => syncGroupsMutation.mutate()}
                    disabled={syncGroupsMutation.isPending || waStatus !== "connected"}
                    data-testid="button-sync-groups">
                    {syncGroupsMutation.isPending ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 ml-1" />}
                    مزامنة قائمة المجموعات من واتساب
                  </Button>

                  {/* Start button */}
                  {(!publishProgress || publishProgress.status !== "running") && (
                    <Button size="sm" className="w-full text-xs h-8 bg-orange-500 hover:bg-orange-600 text-white"
                      onClick={() => { requestNotifPermIfNeeded(); startPublishMutation.mutate(); }}
                      disabled={startPublishMutation.isPending || waStatus !== "connected" || isCoordinatorBusy || !publisherAdsData?.length}
                      data-testid="button-start-publish">
                      {startPublishMutation.isPending ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" /> : <Send className="w-3.5 h-3.5 ml-1" />}
                      بدء النشر للمجموعات المنضمة
                    </Button>
                  )}

                  {/* ── جدولة النشر التلقائي ── */}
                  <Button variant="ghost" size="sm" className={`w-full text-xs h-7 justify-start gap-1 ${showSchedulerPanel ? "text-orange-600" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => setShowSchedulerPanel(o => !o)}
                    data-testid="button-scheduler-toggle">
                    <CalendarClock className="w-3 h-3 ml-1" />
                    {showSchedulerPanel ? "إخفاء الجدولة" : "جدولة النشر التلقائي"}
                    {schedulesData?.schedules?.filter(s => s.enabled).length ? <Badge variant="secondary" className="text-[9px] h-3.5 px-1 mr-auto">{schedulesData.schedules.filter(s => s.enabled).length} نشط</Badge> : null}
                    {showSchedulerPanel ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
                  </Button>
                  {showSchedulerPanel && (
                    <div className="border border-orange-200/60 dark:border-orange-800/40 rounded-lg p-2.5 space-y-2 bg-orange-50/30 dark:bg-orange-900/5">
                      {/* Create form */}
                      <div className="space-y-1.5">
                        <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">إضافة جدول جديد</p>
                        <Input
                          data-testid="input-sched-name"
                          placeholder="اسم الجدول (اختياري)"
                          value={schedName}
                          onChange={e => setSchedName(e.target.value)}
                          className="h-7 text-xs"
                          dir="rtl"
                        />
                        <div className="flex gap-1.5">
                          <Input
                            data-testid="input-sched-value"
                            type="number"
                            min={1}
                            value={schedValue}
                            onChange={e => setSchedValue(e.target.value)}
                            className="h-7 text-xs w-16 flex-shrink-0"
                          />
                          <Select value={schedUnit} onValueChange={v => setSchedUnit(v as IntervalUnit)}>
                            <SelectTrigger className="h-7 text-xs flex-1" data-testid="select-sched-unit">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="seconds">ثواني</SelectItem>
                              <SelectItem value="minutes">دقائق</SelectItem>
                              <SelectItem value="hours">ساعات</SelectItem>
                              <SelectItem value="days">أيام</SelectItem>
                              <SelectItem value="weeks">أسابيع</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            data-testid="button-create-schedule"
                            size="sm"
                            className="h-7 px-2 flex-shrink-0 bg-orange-500 hover:bg-orange-600 text-white"
                            disabled={createScheduleMutation.isPending || !schedValue || Number(schedValue) <= 0}
                            onClick={() => {
                              const iv = Number(schedValue);
                              if (!iv || iv <= 0) return;
                              createScheduleMutation.mutate({ name: schedName, intervalValue: iv, intervalUnit: schedUnit });
                            }}
                          >
                            {createScheduleMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                          </Button>
                        </div>
                        {createScheduleMutation.isError && (
                          <p className="text-[10px] text-red-600">{(createScheduleMutation.error as Error).message}</p>
                        )}
                      </div>
                      {/* List */}
                      {schedulesLoading ? (
                        <div className="flex justify-center py-2"><Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" /></div>
                      ) : !schedulesData?.schedules?.length ? (
                        <p className="text-[10px] text-muted-foreground text-center py-1">لا توجد جداول</p>
                      ) : (
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {schedulesData.schedules.map(sched => (
                            <div key={sched._id} data-testid={`row-schedule-${sched._id}`}
                              className="flex items-center gap-1.5 bg-background border rounded p-1.5 text-[10px]">
                              <Switch
                                data-testid={`switch-schedule-${sched._id}`}
                                checked={sched.enabled}
                                disabled={toggleScheduleMutation.isPending}
                                onCheckedChange={() => toggleScheduleMutation.mutate(sched._id)}
                                className="scale-75 flex-shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <p className="font-medium truncate">{sched.name}</p>
                                <div className="flex items-center gap-1 text-muted-foreground">
                                  <Timer className="w-2.5 h-2.5" />
                                  <span>كل {sched.intervalValue} {UNIT_LABELS[sched.intervalUnit]}</span>
                                  {sched.enabled && sched.nextRunAt && (
                                    <span className="text-orange-600">· {formatNextRun(sched.nextRunAt)}</span>
                                  )}
                                </div>
                              </div>
                              <Button
                                data-testid={`button-del-sched-${sched._id}`}
                                variant="ghost" size="icon"
                                className="h-5 w-5 flex-shrink-0 hover:bg-destructive/10"
                                disabled={deleteScheduleMutation.isPending}
                                onClick={() => deleteScheduleMutation.mutate(sched._id)}
                              >
                                <Trash2 className="w-3 h-3 text-destructive" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── سجل جلسات النشر ── */}
                  <Button variant="ghost" size="sm" className="w-full text-xs h-7 text-muted-foreground hover:text-foreground"
                    onClick={() => { setShowPublishHistory(o => !o); if (!publishHistoryData) void refetchPublishHistory(); }}
                    data-testid="button-publish-history">
                    <History className="w-3 h-3 ml-1" />
                    {showPublishHistory ? "إخفاء السجل" : "سجل جلسات النشر"}
                    {showPublishHistory ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
                  </Button>
                  {showPublishHistory && (
                    <div className="space-y-1.5 mt-1">
                      {!publishHistoryData ? (
                        <div className="flex justify-center py-2"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
                      ) : publishHistoryData.sessions.length === 0 ? (
                        <p className="text-[10px] text-muted-foreground text-center py-2">لا توجد جلسات سابقة</p>
                      ) : (
                        <div className="space-y-1 max-h-52 overflow-y-auto">
                          {publishHistoryData.sessions.map((s, i) => {
                            const startD = new Date(s.startedAt);
                            const endD   = new Date(s.completedAt);
                            const durMin = Math.round((endD.getTime() - startD.getTime()) / 60_000);
                            return (
                              <div key={s._id ?? i} className="bg-background border rounded p-2 text-[10px] space-y-1" data-testid={`publish-session-${i}`}>
                                <div className="flex items-center justify-between">
                                  <span className={`font-semibold ${s.status === "done" ? "text-green-600" : s.status === "stopped" ? "text-yellow-600" : "text-red-600"}`}>
                                    {s.status === "done" ? "✓ مكتملة" : s.status === "stopped" ? "◼ موقوفة" : "✗ خطأ"}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {startD.toLocaleDateString("ar", { month: "short", day: "numeric" })} — {startD.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}
                                  </span>
                                </div>
                                <div className="flex gap-2 text-center">
                                  <div className="flex-1 bg-green-50 dark:bg-green-900/20 rounded p-1"><p className="font-bold text-green-700">{s.sent}</p><p className="text-muted-foreground">أُرسل</p></div>
                                  <div className="flex-1 bg-red-50 dark:bg-red-900/20 rounded p-1"><p className="font-bold text-red-600">{s.failed}</p><p className="text-muted-foreground">فشل</p></div>
                                  <div className="flex-1 bg-gray-50 dark:bg-gray-800 rounded p-1"><p className="font-bold">{durMin}د</p><p className="text-muted-foreground">مدة</p></div>
                                  <div className="flex-1 bg-gray-50 dark:bg-gray-800 rounded p-1"><p className="font-bold">{s.total}</p><p className="text-muted-foreground">إجمالي</p></div>
                                </div>
                                {s.phone && <p className="text-muted-foreground text-right">📱 +{s.phone}</p>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── قائمة المغادرة ── */}
              <Button variant="outline" className={`w-full justify-start gap-2 h-10 ${showLeavePanel ? "border-red-300 bg-red-50 dark:bg-red-900/10" : ""}`}
                onClick={() => { setShowLeavePanel(o => !o); void refetchLeaveQueue(); }}
                data-testid="sidebar-leave-queue">
                <LogOut className="w-4 h-4 text-red-500 flex-shrink-0" />
                <span className="flex-1 text-right text-sm">قائمة المغادرة</span>
                {leaveQueue.filter(e => e.reason === "ad-auto-detected").length > 0 && (
                  <Badge className="text-[10px] h-4 px-1.5 bg-orange-500 hover:bg-orange-500 text-white border-0" data-testid="badge-ad-leave-count">
                    {leaveQueue.filter(e => e.reason === "ad-auto-detected").length} إعلان
                  </Badge>
                )}
                {leaveQueue.length > 0 && <Badge variant="destructive" className="text-[10px]">{leaveQueue.length}</Badge>}
                {showLeavePanel ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
              </Button>
              {showLeavePanel && (
                <div className="border border-red-200 dark:border-red-800 rounded-lg p-3 space-y-2 bg-red-50/50 dark:bg-red-900/10">
                  {leaveQueue.length > 0 ? (
                    <div className="space-y-1.5 max-h-52 overflow-y-auto">
                      {leaveQueue.map((entry) => (
                        <div key={entry.url} className="bg-background rounded p-2 border text-xs space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            {entry.reason === "ad-auto-detected" && (
                              <Badge variant="secondary" className="text-[9px] h-4 px-1 bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 flex-shrink-0">إعلان</Badge>
                            )}
                            <span className="flex-1 font-mono truncate text-muted-foreground">{entry.url.replace("https://chat.whatsapp.com/", "")}</span>
                            <Button size="sm" variant="ghost" className="h-5 w-5 p-0 hover:bg-green-100 flex-shrink-0" title="مغادرة فورية" onClick={() => leaveNowMutation.mutate(entry.url)} disabled={leaveNowMutation.isPending || waStatus !== "connected"} data-testid={`button-leave-now-${entry.url}`}>
                              <LogOut className="w-3 h-3 text-green-600" />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-5 w-5 p-0 hover:bg-destructive/10 flex-shrink-0" onClick={() => dequeueLeaveMutation.mutate(entry.url)} disabled={dequeueLeaveMutation.isPending} data-testid={`button-dequeue-${entry.url}`}>
                              <Trash2 className="w-3 h-3 text-destructive" />
                            </Button>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Timer className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                            <input
                              type="datetime-local"
                              className="flex-1 h-6 text-[10px] bg-muted rounded px-1 border border-border text-foreground"
                              value={entry.scheduledAt ? new Date(entry.scheduledAt).toISOString().slice(0, 16) : ""}
                              onChange={(e) => updateScheduleMutation.mutate({ url: entry.url, scheduledAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
                              data-testid={`input-schedule-${entry.url}`}
                            />
                            {entry.scheduledAt && <Badge variant="outline" className="text-[9px] h-4 px-1 border-amber-400 text-amber-600">مجدول</Badge>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground text-center py-2">قائمة المغادرة فارغة</p>
                  )}
                  <div className="flex gap-1.5 flex-wrap">
                    {activeFunction === "leaving" ? (
                      <>
                        {leaveProgress?.status === "paused" ? (
                          <Button size="sm" variant="outline" className="flex-1 h-8 text-xs border-primary/50 text-primary" onClick={() => resumeLeaveMutation.mutate()} disabled={resumeLeaveMutation.isPending} data-testid="button-resume-leave">
                            <Play className="w-3.5 h-3.5 ml-1" />استئناف
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" className="flex-1 h-8 text-xs border-amber-500/50 text-amber-600 hover:bg-amber-50" onClick={() => pauseLeaveMutation.mutate()} disabled={pauseLeaveMutation.isPending} data-testid="button-pause-leave">
                            <Pause className="w-3.5 h-3.5 ml-1" />تعليق
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="flex-1 h-8 text-xs border-destructive/50 text-destructive" onClick={() => stopLeaveMutation.mutate()} disabled={stopLeaveMutation.isPending} data-testid="button-stop-leave">
                          <Square className="w-3.5 h-3.5 ml-1" />إيقاف
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" className="w-full h-8 text-xs bg-red-500 hover:bg-red-600 text-white"
                        onClick={() => startLeaveMutation.mutate()}
                        disabled={startLeaveMutation.isPending || waStatus !== "connected" || isCoordinatorBusy || leaveQueue.length === 0}
                        data-testid="button-start-leave">
                        {startLeaveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" /> : <LogOut className="w-3.5 h-3.5 ml-1" />}
                        مغادرة الكل ({leaveQueue.length})
                      </Button>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground">تأخير 5–15 ث قبل كل مغادرة · <LogOut className="w-3 h-3 inline text-green-600" /> مغادرة فورية بدون تأخير</p>
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
            <Button
              size="sm" variant="ghost"
              className="text-muted-foreground hover:text-foreground px-2 hidden sm:flex items-center gap-1"
              onClick={() => {
                localStorage.removeItem("workspace_key");
                localStorage.removeItem("workspace_name");
                navigate("/login");
              }}
              data-testid="button-switch-workspace"
              title={`تبديل مساحة العمل${localStorage.getItem("workspace_name") ? " — " + localStorage.getItem("workspace_name") : ""}`}
            >
              <Hash className="w-3.5 h-3.5" />
              <span className="text-xs">{localStorage.getItem("workspace_name") ?? "تبديل"}</span>
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
                      onClick={() => setStep("links")}
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
                      onClick={() => openWithKey("/api/whatsapp/download-groups")}
                      disabled={!previousResults.groups}
                      data-testid="button-prev-download-groups">
                      <Download className="w-3.5 h-3.5 ml-1.5" />
                      <span className="truncate">ملف المجموعات ({previousResults.groups ?? 0})</span>
                    </Button>
                    <Button size="sm" variant="outline" className="flex-1 min-w-0"
                      onClick={() => openWithKey("/api/whatsapp/download-ads")}
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
                        onClick={() => openWithKey("/api/whatsapp/download-join-results")}
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
            {/* Bulk paste links */}
            <Card>
              <CardContent className="pt-4 space-y-2">
                <button
                  className="w-full flex items-center justify-between text-sm font-semibold hover:text-primary transition-colors"
                  onClick={() => setShowBulkPaste(o => !o)}
                  data-testid="button-toggle-bulk-paste"
                >
                  <span className="flex items-center gap-2">
                    <Link2 className="w-4 h-4 text-primary" />
                    لصق روابط واتساب مباشرة
                  </span>
                  {showBulkPaste ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </button>
                {showBulkPaste && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs text-muted-foreground">الصق روابط واتساب (رابط واحد في كل سطر) وستُضاف مباشرة إلى المستودع</p>
                    <textarea
                      className="w-full h-28 text-xs font-mono rounded border bg-muted/40 p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder={"https://chat.whatsapp.com/ABC123\nhttps://chat.whatsapp.com/DEF456\n..."}
                      value={bulkPasteText}
                      onChange={(e) => setBulkPasteText(e.target.value)}
                      data-testid="textarea-bulk-paste"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground">
                        <span className="font-semibold text-primary">{extractBulkLinks(bulkPasteText).length}</span> رابط واتساب صالح مكتشف
                      </span>
                      <Button size="sm" className="h-8 text-xs px-3"
                        onClick={() => {
                          const urls = extractBulkLinks(bulkPasteText);
                          if (urls.length) bulkPasteMutation.mutate(urls);
                        }}
                        disabled={bulkPasteMutation.isPending || extractBulkLinks(bulkPasteText).length === 0}
                        data-testid="button-bulk-paste-submit">
                        {bulkPasteMutation.isPending ? <Loader2 className="w-3.5 h-3.5 ml-1 animate-spin" /> : <PlusCircle className="w-3.5 h-3.5 ml-1" />}
                        إضافة إلى المستودع
                      </Button>
                    </div>
                  </div>
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
                  <Button className="w-full" variant="outline" onClick={() => openWithKey("/api/download/whatsapp")} disabled={!linkCounts.whatsapp} data-testid="button-download-whatsapp">
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
                  <Button className="w-full" variant="outline" onClick={() => openWithKey("/api/download/telegram")} disabled={!linkCounts.telegram} data-testid="button-download-telegram">
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
                      <Button key={batchNum} variant="outline" size="sm" className="gap-1.5"
                        onClick={() => openWithKey(`/api/whatsapp/download-batch/${batchNum}`)}
                        data-testid={`link-download-batch-${batchNum}`}>
                        <Download className="w-3.5 h-3.5" />
                        الدفعة {batchNum}
                      </Button>
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
                    onClick={() => openWithKey("/api/whatsapp/download-groups")}
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
                    onClick={() => openWithKey("/api/whatsapp/download-ads")}
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
                    onClick={() => openWithKey("/api/whatsapp/download-description-links")}
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
                    onClick={() => openWithKey("/api/download/telegram")}
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
                onClick={() => openWithKey("/api/whatsapp/download-groups")}
                disabled={!filteredSummary || filteredSummary.groups === 0}
                className="flex-col h-16 gap-1 text-xs"
                data-testid="button-dl-groups-bottom">
                <Download className="w-4 h-4" />
                <span>ملف المجموعات</span>
              </Button>
              <Button variant="outline"
                onClick={() => openWithKey("/api/whatsapp/download-ads")}
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

