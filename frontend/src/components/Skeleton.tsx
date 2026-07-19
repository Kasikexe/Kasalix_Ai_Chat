export function Skeleton({ className = '', variant = 'text' }: { className?: string; variant?: 'text' | 'circle' | 'rect' }) {
  const base = 'animate-pulse bg-gray-700/50 rounded';
  const shape = variant === 'circle' ? 'rounded-full' : variant === 'rect' ? 'rounded-lg' : 'rounded';
  return (
    <div className={`${base} ${shape} ${className}`} />
  );
}

export function MessageSkeleton() {
  return (
    <div className="flex gap-3 px-4 py-6">
      <Skeleton variant="circle" className="w-8 h-8 flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}

export function ConversationSkeleton() {
  return (
    <div className="px-3 py-3 flex items-center gap-2">
      <Skeleton variant="circle" className="w-2 h-2 flex-shrink-0" />
      <Skeleton className="h-4 flex-1" />
    </div>
  );
}

export function ModelSkeleton() {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-4 w-12 ml-auto" />
    </div>
  );
}
