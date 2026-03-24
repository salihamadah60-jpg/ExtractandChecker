import { motion } from "framer-motion"
import { ExternalLink, Link as LinkIcon, AlertTriangle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { LinkResult } from "@workspace/api-client-react/src/generated/api.schemas"

interface LinkTableProps {
  results: LinkResult[]
}

export function LinkTable({ results }: LinkTableProps) {
  if (!results.length) return null;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.2, type: "spring", stiffness: 200, damping: 20 }}
      className="bg-card rounded-2xl shadow-xl shadow-black/5 border border-border/50 overflow-hidden"
    >
      <div className="p-6 border-b border-border/50 flex justify-between items-center bg-muted/20">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 text-primary rounded-lg">
            <LinkIcon className="w-5 h-5" />
          </div>
          <h3 className="font-display text-xl font-bold text-foreground">Extracted Links</h3>
        </div>
        <Badge variant="outline" className="px-3 py-1 text-sm bg-background">
          {results.length} results
        </Badge>
      </div>

      <div className="divide-y divide-border/50 max-h-[600px] overflow-y-auto">
        {results.map((link, i) => (
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3, delay: i * 0.02 }}
            key={i} 
            className="p-4 sm:p-5 hover:bg-muted/30 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-4 group"
          >
            <div className="flex-1 min-w-0 pr-4">
              <div className="flex items-center gap-2 mb-1.5">
                <p className="font-medium text-foreground truncate text-sm sm:text-base">
                  {link.text ? link.text.trim() : <span className="text-muted-foreground italic font-normal">No anchor text</span>}
                </p>
                {link.error && (
                  <div title={link.error}>
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                  </div>
                )}
              </div>
              <a 
                href={link.url} 
                target="_blank" 
                rel="noreferrer" 
                className="text-sm text-primary/80 hover:text-primary hover:underline truncate flex items-center gap-1.5 w-max max-w-full"
              >
                {link.url}
                <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              </a>
            </div>
            <div className="flex items-center gap-3 shrink-0 self-start sm:self-auto">
              <span className="text-xs sm:text-sm font-mono font-medium text-muted-foreground bg-muted/50 border border-border/50 px-2.5 py-1 rounded-md min-w-[3.5rem] text-center">
                {link.status !== null ? link.status : 'ERR'}
              </span>
              {link.active ? (
                <Badge variant="success" className="w-[4.5rem] justify-center shadow-sm">Active</Badge>
              ) : (
                <Badge variant="destructive" className="w-[4.5rem] justify-center shadow-sm">Broken</Badge>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  )
}
