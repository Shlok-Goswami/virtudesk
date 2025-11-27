'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOrganization } from '@clerk/nextjs';
import { getMeetingSummaries } from '@/app/actions/Summary';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  Loader2,
  RefreshCcw,
  Users,
} from 'lucide-react';

type MeetingSummary = {
  id: string;
  room_id: string;
  org_id: string;
  created_by?: string;
  summary_text: string;
  key_points: string[];
  participants: string[];
  participant_names: Record<string, string>;
  duration_ms: number;
  start_time: string;
  end_time: string;
  created_at: string;
  transcriptions?: Array<{
    id: string;
    name?: string;
    text: string;
  }>;
};

export default function MeetingsPage() {
  const { organization } = useOrganization();
  const [summaries, setSummaries] = useState<MeetingSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const orgId = organization?.id ?? null;

  const fetchSummaries = useCallback(async () => {
    if (!orgId) return;

    setIsLoading(true);
    setError(null);
    setExpandedId(null);

    try {
      const data = await getMeetingSummaries(orgId);
      setSummaries(data);
    } catch (err) {
      console.error('Error loading meeting summaries:', err);
      setError('Failed to load meeting summaries. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    if (!orgId) {
      setSummaries([]);
      return;
    }

    fetchSummaries();
  }, [orgId, fetchSummaries]);

  const formatDuration = useCallback((ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) {
      return '—';
    }

    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
  }, []);

  const formatDateTime = useCallback((value: string): string => {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return '—';
    }

    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, []);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  const organizationLabel = useMemo(() => {
    if (!organization?.name) {
      return 'Select an organization to view meeting summaries.';
    }

    return `Showing meetings for ${organization.name}`;
  }, [organization?.name]);

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight flex items-center gap-2">
          <FileText className="h-7 w-7 text-primary" />
          Meeting Summaries
        </h1>
        <p className="text-muted-foreground">
          Review AI-generated recaps and key takeaways from your organization’s recent meetings.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">{organizationLabel}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchSummaries}
          disabled={isLoading || !orgId}
          className="flex items-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading
            </>
          ) : (
            <>
              <RefreshCcw className="h-4 w-4" />
              Refresh
            </>
          )}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!orgId ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          <FileText className="h-10 w-10 opacity-50" />
          <div>
            <p className="font-medium text-foreground">No organization selected</p>
            <p className="text-sm">
              Join or create an organization to access your meeting summaries.
            </p>
          </div>
        </div>
      ) : isLoading && summaries.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index} className="border-muted-foreground/10">
              <CardHeader>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-3 h-3 w-48" />
                <Skeleton className="mt-2 h-3 w-36" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-4 w-28" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : summaries.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center text-muted-foreground">
          <FileText className="h-10 w-10 opacity-50" />
          <div>
            <p className="font-medium text-foreground">No meeting summaries yet</p>
            <p className="text-sm">Summaries will appear after meetings conclude.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {summaries.map((summary) => (
            <Card key={summary.id} className="transition-shadow hover:shadow-md">
              <CardHeader className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="space-y-2">
                  <CardTitle className="text-lg">Meeting Summary</CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-4 text-sm">
                    <span className="flex items-center gap-1">
                      <Calendar className="h-4 w-4" />
                      {formatDateTime(summary.start_time)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-4 w-4" />
                      {formatDuration(summary.duration_ms)}
                    </span>
                    <span className="flex items-center gap-1">
                      <Users className="h-4 w-4" />
                      {summary.participants?.length ?? 0} participant
                      {(summary.participants?.length ?? 0) === 1 ? '' : 's'}
                    </span>
                  </CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleToggleExpand(summary.id)}
                  className="ml-auto flex h-8 w-8 items-center justify-center p-0"
                >
                  {expandedId === summary.id ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </Button>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-muted-foreground">Summary</h3>
                  <p className="text-sm leading-relaxed text-foreground">
                    {summary.summary_text}
                  </p>
                </div>

                {summary.key_points && summary.key_points.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-muted-foreground">Key Points</h3>
                    <div className="flex flex-wrap gap-2">
                      {summary.key_points.map((point, idx) => (
                        <Badge key={idx} variant="secondary" className="text-xs">
                          {point}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {expandedId === summary.id && (
                  <div className="space-y-6 border-t pt-6">
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold text-muted-foreground">
                        Time Details
                      </h3>
                      <div className="space-y-1 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Start:</span>
                          <span>{formatDateTime(summary.start_time)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">End:</span>
                          <span>{formatDateTime(summary.end_time)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Duration:</span>
                          <span>{formatDuration(summary.duration_ms)}</span>
                        </div>
                      </div>
                    </div>

                    {summary.participants && summary.participants.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-sm font-semibold text-muted-foreground">
                          Participants
                        </h3>
                        <div className="flex flex-wrap gap-2">
                          {summary.participants.map((id, idx) => (
                            <Badge key={idx} variant="outline" className="text-xs">
                              {summary.participant_names?.[id] || id}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {summary.transcriptions && summary.transcriptions.length > 0 && (
                      <div className="space-y-3 mt-4">
                        <h3 className="text-sm font-semibold text-muted-foreground">Transcriptions</h3>
                        <div className="flex flex-col gap-3">
                          {summary.transcriptions.map((t, idx) => (
                            <div
                              key={idx}
                              className="rounded-md border border-muted/30 bg-muted/10 p-3"
                            >
                              <p className="text-sm font-medium text-foreground mb-1">
                                🗣 {t.name || summary.participant_names?.[t.id] || t.id}
                              </p>
                              <p className="text-sm text-muted-foreground whitespace-pre-line">
                                {t.text || '(no transcription available)'}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
