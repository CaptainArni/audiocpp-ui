import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Grid,
  Group,
  Image,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip,
} from "@mantine/core";
import { Dropzone } from "@mantine/dropzone";
import { IconInfoCircle, IconPhoto, IconRefresh, IconScan, IconTrash, IconUpload, IconX } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { api } from "../api";
import type { OcrModelInfo, OcrResult } from "../types";

interface Run {
  key: number;
  modelId: string;
  result: OcrResult;
  chars: number;
}

export function OcrPanel() {
  const [models, setModels] = useState<OcrModelInfo[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);

  const model = useMemo(() => models.find((m) => m.id === modelId) ?? null, [models, modelId]);

  useEffect(() => {
    api
      .getOcrModels()
      .then(({ models, default: def }) => {
        setModels(models);
        const initial = def || models[0]?.id || null;
        setModelId(initial);
        const m = models.find((x) => x.id === initial);
        if (m) setPrompt(m.prompt);
      })
      .catch((err) => notifications.show({ color: "red", title: "Couldn't load OCR models", message: err.message }));
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const onSelectModel = (id: string | null) => {
    setModelId(id);
    const m = models.find((x) => x.id === id);
    if (m) setPrompt(m.prompt); // prefill with this model's default prompt
  };

  const onDrop = (files: File[]) => {
    const f = files[0];
    if (!f) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
  };

  const run = async () => {
    if (!file) {
      notifications.show({ color: "yellow", message: "Drop an image first." });
      return;
    }
    setRunning(true);
    try {
      const result = await api.ocr(file, modelId ?? undefined, prompt.trim() || undefined);
      setRuns((rs) => [{ key: Date.now(), modelId: modelId ?? "?", result, chars: result.text.length }, ...rs]);
    } catch (err) {
      notifications.show({ color: "red", title: "OCR failed", message: (err as Error).message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Grid gap="md">
      {/* Left: the image + run controls */}
      <Grid.Col span={{ base: 12, md: 5 }}>
        <Paper withBorder p="md" radius="md">
          <Stack gap="md">
            <Title order={5}>OCR test bench</Title>

            {previewUrl ? (
              <Stack gap="xs">
                <Image src={previewUrl} alt="page" mah={280} fit="contain" radius="sm" />
                <Group justify="space-between">
                  <Text size="xs" c="dimmed" truncate>
                    {file?.name} · {file ? Math.round(file.size / 1024) : 0} KB
                  </Text>
                  <Button size="xs" variant="subtle" onClick={() => onDropReset()}>
                    Choose another
                  </Button>
                </Group>
              </Stack>
            ) : (
              <Dropzone onDrop={onDrop} accept={["image/*"]} maxFiles={1} multiple={false}>
                <Group justify="center" gap="md" mih={140} style={{ pointerEvents: "none" }}>
                  <Dropzone.Accept>
                    <IconUpload size={40} />
                  </Dropzone.Accept>
                  <Dropzone.Reject>
                    <IconX size={40} />
                  </Dropzone.Reject>
                  <Dropzone.Idle>
                    <IconPhoto size={40} />
                  </Dropzone.Idle>
                  <div>
                    <Text size="sm">Drop a page photo here, or click to browse</Text>
                    <Text size="xs" c="dimmed">
                      Run the same image through different OCR models to compare.
                    </Text>
                  </div>
                </Group>
              </Dropzone>
            )}

            <Select
              label="OCR model"
              data={models.map((m) => ({ value: m.id, label: m.label }))}
              value={modelId}
              onChange={onSelectModel}
            />

            <Textarea
              label="Prompt"
              description="Prefilled from the model's default — edit to experiment (PaddleOCR-VL wants 'OCR:')"
              autosize
              minRows={3}
              maxRows={10}
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
            />
            <Group>
              <Button leftSection={<IconScan size={18} />} onClick={run} loading={running} disabled={!file}>
                Run OCR
              </Button>
              {model && (
                <Tooltip label="Reset prompt to this model's default">
                  <ActionIcon variant="light" size="lg" onClick={() => setPrompt(model.prompt)}>
                    <IconRefresh size={18} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          </Stack>
        </Paper>
      </Grid.Col>

      {/* Right: results, newest first, for A/B comparison */}
      <Grid.Col span={{ base: 12, md: 7 }}>
        <Paper withBorder p="md" radius="md">
          <Group justify="space-between" mb="sm">
            <Title order={5}>Results ({runs.length})</Title>
            {runs.length > 0 && (
              <Button size="xs" variant="subtle" color="gray" leftSection={<IconTrash size={14} />} onClick={() => setRuns([])}>
                Clear
              </Button>
            )}
          </Group>
          {runs.length === 0 ? (
            <Alert icon={<IconInfoCircle size={18} />} color="gray" variant="light">
              Runs appear here with their model, timing and character count — handy for comparing PaddleOCR-VL vs Gemma
              on the same page.
            </Alert>
          ) : (
            <Stack gap="sm">
              {runs.map((r) => (
                <Paper key={r.key} withBorder p="sm" radius="sm">
                  <Group justify="space-between" mb={6} wrap="nowrap">
                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                      <Badge variant="light">{r.modelId}</Badge>
                      <Badge variant="light" color="blue">
                        {r.result.seconds.toFixed(2)}s
                      </Badge>
                      <Badge variant="light" color="gray">
                        {r.chars} chars
                      </Badge>
                      {r.result.truncated && (
                        <Badge variant="light" color="yellow">
                          truncated
                        </Badge>
                      )}
                    </Group>
                  </Group>
                  <ScrollArea.Autosize mah={260} type="auto">
                    <Text size="sm" style={{ fontFamily: "Georgia, serif", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                      {r.result.text || <Text component="span" c="dimmed">(no text returned)</Text>}
                    </Text>
                  </ScrollArea.Autosize>
                </Paper>
              ))}
            </Stack>
          )}
        </Paper>
      </Grid.Col>
    </Grid>
  );

  function onDropReset() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setFile(null);
  }
}
