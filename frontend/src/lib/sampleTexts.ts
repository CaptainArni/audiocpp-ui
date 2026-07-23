// Ready-made reference passages to read aloud when recording a new voice.
//
// The reference text is what the TTS model conditions on, so each sample is
// sized like a typical saved clip (~20–30 s of speech, ~300–350 characters) and
// written in a distinct register — the register you read in is the register the
// cloned voice will lean towards. Kept in sync with the Android app's
// SampleTexts.kt (categories mirror the voice names already in use).

export interface SampleText {
  label: string;
  text: string;
}

export const sampleTexts: SampleText[] = [
  {
    label: "Vorlesen (neutral)",
    text:
      "Die alte Bibliothek lag im Herzen der Stadt, umgeben von schmalen Gassen und " +
      "hohen Häusern. Wer durch die schwere Holztür trat, spürte sofort die Stille, " +
      "die zwischen den Regalen wohnte. Tausende Bücher reihten sich aneinander, " +
      "manche so alt, dass ihre Seiten vergilbt und brüchig geworden waren. Es roch " +
      "nach Papier, Staub und vergangenen Zeiten.",
  },
  {
    label: "Kinderbuch",
    text:
      "Es war einmal ein kleiner Bär, der wohnte am Rand des großen Waldes. Jeden " +
      "Morgen, wenn die Sonne aufging, kletterte er auf seinen Lieblingsbaum und " +
      "schaute den Vögeln zu. Am liebsten mochte er die kleine Amsel, die jeden Tag " +
      "ein neues Lied für ihn sang. Eines Tages beschloss der kleine Bär, das Lied " +
      "endlich selbst zu lernen.",
  },
  {
    label: "Kindergeschichte (Gute Nacht)",
    text:
      "Schlaf gut, kleiner Freund, die Sterne sind schon da. Der Mond schaut durch das " +
      "Fenster und passt die ganze Nacht auf dich auf. Die Bäume wiegen sich ganz " +
      "leise im Wind, und alle Tiere im Wald machen jetzt die Augen zu. Auch du " +
      "darfst nun die Augen schließen und von schönen Dingen träumen. Gute Nacht, " +
      "schlaf schön, und träume süß.",
  },
  {
    label: "Nachrichten",
    text:
      "Guten Abend, meine Damen und Herren, und herzlich willkommen zu den Nachrichten. " +
      "Die Wetterlage bleibt in den kommenden Tagen wechselhaft. Während im Norden " +
      "mit Regen zu rechnen ist, bleibt es im Süden überwiegend trocken und mild. In " +
      "der Wirtschaft zeigten sich die Märkte heute weitgehend stabil. Wir wünschen " +
      "Ihnen einen angenehmen Abend.",
  },
  {
    label: "Podcast",
    text:
      "Also, herzlich willkommen zurück zur neuen Folge. Ich freue mich riesig, dass " +
      "ihr wieder eingeschaltet habt. Heute sprechen wir über ein Thema, das mich " +
      "schon lange beschäftigt, und ehrlich gesagt könnte ich stundenlang darüber " +
      "reden. Aber keine Sorge, ich fasse mich kurz. Schnappt euch einen Kaffee und " +
      "lasst uns direkt loslegen.",
  },
  {
    label: "Sachlich (Dokumentation)",
    text:
      "Der Nordatlantik gehört zu den stürmischsten Meeren der Erde. Über Jahrhunderte " +
      "wagten sich Seefahrer in diese Gewässer, oft mit einfachen Holzschiffen und " +
      "ohne verlässliche Karten. Wind und Strömung bestimmten über Erfolg oder " +
      "Untergang. Erst mit dem Bau der großen Leuchttürme wurde die Küste bei Nacht " +
      "ein Stück weit berechenbar.",
  },
];
