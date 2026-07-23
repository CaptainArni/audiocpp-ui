import { Accordion, Group, NumberInput, Select, TextInput } from "@mantine/core";
import { IconAdjustments } from "@tabler/icons-react";
import type { TtsParams } from "../types";

interface Props {
  params: TtsParams;
  onChange: (p: TtsParams) => void;
  /** Languages the selected model actually supports; shown as a dropdown when known. */
  languages?: string[];
}

export function ParamsAccordion({ params, onChange, languages = [] }: Props) {
  const num = (key: keyof TtsParams) => (v: number | string) =>
    onChange({ ...params, [key]: v === "" || v === undefined ? undefined : Number(v) });

  return (
    <Accordion variant="separated">
      <Accordion.Item value="params">
        <Accordion.Control icon={<IconAdjustments size={18} />}>Advanced parameters</Accordion.Control>
        <Accordion.Panel>
          <Group grow>
            <NumberInput
              label="Seed"
              placeholder="random"
              value={params.seed ?? ""}
              onChange={num("seed")}
              allowDecimal={false}
            />
            <NumberInput
              label="Max tokens"
              placeholder="model default"
              value={params.max_tokens ?? ""}
              onChange={num("max_tokens")}
              allowDecimal={false}
              min={1}
            />
          </Group>
          <Group grow mt="sm">
            <NumberInput
              label="Temperature"
              placeholder="model default"
              value={params.temperature ?? ""}
              onChange={num("temperature")}
              step={0.05}
              decimalScale={2}
              min={0}
            />
            <NumberInput
              label="Top-p"
              placeholder="model default"
              value={params.top_p ?? ""}
              onChange={num("top_p")}
              step={0.05}
              decimalScale={2}
              min={0}
              max={1}
            />
            <NumberInput
              label="Top-k"
              placeholder="model default"
              value={params.top_k ?? ""}
              onChange={num("top_k")}
              allowDecimal={false}
              min={0}
            />
          </Group>
          {languages.length > 0 ? (
            <Select
              mt="sm"
              label="Language (optional)"
              placeholder="model default"
              description="Languages this model supports"
              searchable
              clearable
              data={languages}
              value={params.language ?? null}
              onChange={(v) => onChange({ ...params, language: v || undefined })}
            />
          ) : (
            <TextInput
              mt="sm"
              label="Language (optional)"
              placeholder="e.g. english"
              value={params.language ?? ""}
              onChange={(e) => onChange({ ...params, language: e.currentTarget.value || undefined })}
            />
          )}
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
