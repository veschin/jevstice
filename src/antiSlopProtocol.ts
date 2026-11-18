/**
 * The bilingual editing protocol attached to the anti-slop review.
 *
 * A protocol is an ordered editing procedure plus exactly four built-in checks. The guidance text
 * for the registered tool is rendered from these same objects, so the instructions a model reads
 * and the protocol used while judging cannot drift apart.
 */

/** One ordered editing protocol for a supported artifact language. */
export interface AntiSlopProtocol {
	language: "ru" | "en";
	steps: readonly string[];
	checks: readonly { class: string; rule: string; repair: string }[];
}

const PROTECTED_RU =
	"Проверка относится только к редактируемой прозе; цитаты и цитируемые образцы, код, формулы, ссылки и URL, сноски, идентификаторы, имена, технические символы, полезная разметка Markdown и диакритика исключены.";
const PROTECTED_EN =
	"The check applies only to editable prose; quotations and quoted samples, code, math, citations, links and URLs, footnotes, identifiers, names, technical symbols, useful Markdown and diacritics are exempt.";

const RUSSIAN: AntiSlopProtocol = {
	language: "ru",
	steps: [
		`Зафиксируйте смысл до правки: выпишите факты, числа, даты, имена, точные названия, отрицания и оговорки о неопределённости. Сохраните их без изменений. Пример: "срок - 14 дней" не превращайте в "около двух недель"; "не поддерживается" не заменяйте на "может не поддерживаться".`,
		`Уберите повторы, материал вне темы, слова-заполнители ("очень", "довольно", "на самом деле", "в принципе") и вводные фразы о самом тексте или работе: "в этой статье", "стоит отметить", "как уже говорилось". Оставьте одну мысль на предложение. Пример: "Стоит отметить, что сервис, как уже говорилось, поддерживает экспорт" -> "Сервис поддерживает экспорт".`,
		`Снимите неподтверждённые оценки, рекламу и абстрактные существительные: "инновационный", "эффективный", "качественный", "оптимизация процессов". Замените их тем действием или числом, которое подтверждает источник. Пример: "Инновационное решение обеспечивает высокую эффективность" -> "Сервис сокращает время сборки"; вторую фразу берите только тогда, когда источник это утверждает, иначе оставьте только проверяемый факт.`,
		`В обычной прозе постройте полное предложение с подлежащим и сказуемым. Императив с подразумеваемым субъектом допустим ("Выберите файл"); заголовки и короткие пункты списка могут обходиться без сказуемого. Называйте деятеля и используйте активный залог, если он известен. Пример: "Осуществляется проверка подписи системой" -> "Система проверяет подпись". Безличный пассив оставляйте, если деятель неизвестен: "Подпись проверяется". Информативное противопоставление допустимо. Формальный тон требует точности и полных предложений. Канцелярит формальностью не считается: не превращайте действия в "осуществление", "проведение", "оптимизацию".`,
		`Разберите риторические конструкции: "не X, а Y", "не только X, но и Y", афоризмы-лозунги и одинаковые шаблоны с подзаголовками в параллельных разделах. Перестройте предложение или раздел, а не заменяйте отдельные слова. Пример: "Это не просто инструмент, а новая философия" -> "Инструмент проверяет текст и возвращает список нарушений"; "Не только ускоряет сборку, но и улучшает качество" -> "Сборка идёт быстрее, тесты ловят больше ошибок", если оба факта подтверждены. Информативное противопоставление сохраняйте: "не слова, а токены" уточняет устройство и остаётся.`,
		`Уберите декоративные символы в прозе: эмодзи, звёздочки, декоративные стрелки, восклицательные знаки ради эффекта. Декоративные длинные тире замените запятой, двоеточием или границей предложения; фигурные кавычки и многоточие - обычной пунктуацией, если стиль владельца не требует иного. Пример: "Готово! [эмодзи] Релиз вышел" -> "Релиз вышел". Не трогайте цитаты, код, формулы, ссылки и URL, сноски, идентификаторы, имена, технические символы, полезную разметку Markdown и диакритику.`,
		`Проверьте связность: свяжите каждое предложение с соседним причиной, следствием, контрастом или уточнением; держите одну тему на абзац. Уберите осиротевшие факты и повторные выводы.`,
		`Проверьте сохранность содержания, если исходный текст доступен: не добавляйте факты, не усиливайте уверенность и не придумывайте новый механизм или причину. Если исходного текста нет, не выдумывайте нарушение и оценивайте только то, что видно. Если источник говорит "может", оставляйте "может". Юридический и технический смысл сохраняйте там, где он важен. Не удаляйте оговорки о неопределённости ("возможно", "по предварительным данным"), если они отражают источник; удаляйте только неподтверждённую уверенность, а не неуверенность.`,
		`Отправьте в jev_anti_slop точный исправленный текст и все утверждения (claims) - факты и гипотезы - с доказательствами. Для вывода (inference) укажите посылки, основание и заключение; для гипотезы - опровергающее условие (falsifier). Пустой список claims допустим, только если в тексте нет утверждений (ни фактов, ни гипотез); пустой список не подтверждает факты и не доказывает, что утверждений не было.`,
		`Меняйте только то, на что указали findings: цитируемый фрагмент и предложенный repair. Не переписывайте весь текст заново и не отправляйте неизменённый материал повторно, чтобы получить другой вердикт.`,
		`После правки проверьте изменённые фрагменты заново. Ответ unavailable или inconclusive не означает, что текст чист; сообщите о нём как о неопределённом результате.`,
		`Помните: инструмент проверяет текст, но не переписывает его и не подтверждает факты. Факты остаются предметом доказательств, а не следствием вердикта.`,
	],
	checks: [
		{
			class: "symbols",
			rule: `В редактируемой прозе нет декоративных эмодзи, звёздочек, декоративных стрелок и восклицательных знаков ради эффекта; декоративные длинные тире заменены запятой, двоеточием или границей предложения; фигурные кавычки и многоточие заменены обычной пунктуацией, если стиль владельца не требует иного. ${PROTECTED_RU}`,
			repair: `Только в редактируемой прозе: удалите декоративный символ или замените его обычной пунктуацией: "Готово! [эмодзи]" -> "Готово". Длинное тире замените запятой, двоеточием или точкой; фигурные кавычки и многоточие - обычными знаками, если стиль владельца не требует иного. Сохраняйте символ, который несёт смысл в коде, формуле, цитате, ссылке или имени.`,
		},
		{
			class: "wording",
			rule: `Нет повторов, материала вне темы, вводных мета-фраз и неподтверждённых оценок; абстрактные существительные заменены действием или числом, которое подтверждает источник; канцелярит не принимается за формальность. Текст не содержит утверждений, не подкреплённых доказательствами, и не усиливает уверенность сверх доказательств; имена, точные названия, отрицания и оговорки о неопределённости внутренне согласованы, и текст не превращает оговорку в уверенное утверждение. Если исходный текст не передан, его отсутствие не является нарушением: оценивайте только то, что видно в тексте. ${PROTECTED_RU}`,
			repair: `Только в редактируемой прозе: сократите повтор или вводную фразу; замените рекламу и абстракцию тем, что источник действительно утверждает, либо удалите утверждение: "Стоит отметить, что это инновационное решение" -> "Сервис поддерживает экспорт", если источник это подтверждает. Не добавляйте факты и не усиливайте уверенность. Не заявляйте, что факт изменён, если исходный текст не передан; оценивайте только видимый текст.`,
		},
		{
			class: "syntax",
			rule: `Полные предложения в прозе имеют подлежащее и сказуемое, но императив с подразумеваемым субъектом ("Выберите файл, затем нажмите кнопку") не считается нарушением; заголовок и короткий пункт списка также не требуют сказуемого; известный деятель назван, используется активный залог, а безличный пассив допустим, если деятель неизвестен; информативное противопоставление сохраняется; риторические "не X, а Y", "не только X, но и Y", афоризмы и одинаковые шаблоны-подзаголовки перестроены, а не переименованы. ${PROTECTED_RU}`,
			repair: `Только в редактируемой прозе: перестройте предложение в конкретное утверждение с деятелем и действием: "Осуществляется проверка системой" -> "Система проверяет". Сохраняйте информативное противопоставление и юридический или технический смысл; безличный пассив оставляйте, если деятель неизвестен.`,
		},
		{
			class: "coherence",
			rule: `Каждое предложение связано с соседним причиной, следствием, контрастом или уточнением; у абзаца одна тема; вывод не повторяется и не висит без основания. ${PROTECTED_RU}`,
			repair: `Только в редактируемой прозе: соедините соседние предложения явной связью или объедините их: "Сборка запускается после каждого коммита. Она занимает 30 секунд." -> "Сборка запускается после каждого коммита и занимает 30 секунд." Уберите осиротевший факт и повторный вывод.`,
		},
	],
};

const ENGLISH: AntiSlopProtocol = {
	language: "en",
	steps: [
		`Lock the meaning before editing: list the facts, numbers, dates, names, exact titles, negations and uncertainty qualifiers. Keep them unchanged. Do not turn "within 14 days" into "about two weeks", and do not soften "not supported" into "may not be supported".`,
		`Cut repetition, off-topic material, filler words ("very", "quite", "actually", "basically") and meta introductions about the text or the work: "in this article", "it is worth noting", "as mentioned earlier". Keep one idea per sentence. Example: "It is worth noting that, as mentioned earlier, the service supports export" -> "The service supports export".`,
		`Remove unsupported praise, hype and abstract nouns: "innovative", "effective", "high-quality", "process optimization". Replace them with the action or number the source actually supports. Example: "The innovative solution delivers high efficiency" -> "The service shortens the build"; use the second sentence only when the source states it, otherwise keep only the verifiable fact.`,
		`In ordinary prose, build a complete sentence with a subject and a predicate. An imperative with an implied subject is legitimate ("Select the file"); headings and short list items may omit a predicate. Name the actor and use the active voice when the actor is known. Example: "Verification of the signature is performed by the system" -> "The system verifies the signature". Keep the passive when the actor is unknown: "The signature is verified". An informative contrast is legitimate. Formality requires precision and complete sentences. Bureaucratic nominalization is not formality: do not turn actions into "carrying out", "implementation" or "optimization".`,
		`Dismantle rhetorical shapes: "not X but Y", "not only X but also Y", slogan aphorisms, and the same labeled template repeated across parallel sections. Rebuild the sentence or section; do not swap individual words. Example: "This is not just a tool, but a philosophy" -> "The tool checks text and returns a list of violations"; "Not only does it speed up the build, but it also improves quality" -> "The build runs faster and the tests catch more defects", when both facts are supported. Preserve an informative contrast: "not words, but tokens" explains the mechanism and stays.`,
		`Remove decorative symbols from prose: emojis, stars, decorative arrows and exclamation marks used for effect. Replace ornamental long dashes with a comma, colon or sentence boundary; replace curly quotes and ellipses with ordinary punctuation when the owner's style does not require them. Example: "Done! [emoji] The release shipped" -> "The release shipped". Do not touch quotations, code, math, citations, links and URLs, identifiers, names, technical symbols, useful Markdown or diacritics.`,
		`Check coherence: link each sentence to its neighbour by cause, consequence, contrast or clarification; keep one topic per paragraph. Remove orphan facts and repeated conclusions.`,
		`Check that no content was added when the original text is available: no new facts, stronger certainty, or invented mechanism or cause. When the original text is not available, do not invent a violation and judge only what the text shows. If the source says "may", keep "may". Preserve legal and technical meaning where it matters. Do not remove uncertainty qualifiers ("possibly", "preliminary data suggests") when the source carries them; remove unsupported certainty, never the uncertainty itself.`,
		`Submit the exact revised text and all actual claims - facts and hypotheses - with evidence to jev_anti_slop. Give each inference its premises, warrant and conclusion; give each hypothesis a falsifier. An empty claims list is valid only when the text makes no assertion, factual or hypothetical; the empty list does not verify facts or prove that no claim was omitted.`,
		`Change only what the findings cite: the quoted fragment and the proposed repair. Do not rewrite the whole text or resubmit unchanged material to seek another verdict.`,
		`Recheck the changed material after each edit. An unavailable or inconclusive answer is not a clean result; report it as unresolved.`,
		`Remember: the tool reviews text; it does not rewrite it and does not prove facts. Facts remain subject to evidence, not to a verdict.`,
	],
	checks: [
		{
			class: "symbols",
			rule: `Editable prose contains no decorative emojis, stars, decorative arrows or exclamation marks used for effect; ornamental long dashes are replaced with a comma, colon or sentence boundary, and curly quotes and ellipses are replaced with ordinary punctuation when the owner's style does not require them. ${PROTECTED_EN}`,
			repair: `Only in editable prose: delete the decorative symbol or replace it with ordinary punctuation: "Done! [emoji]" -> "Done". Replace a long dash with a comma, colon or full stop; replace curly quotes and an ellipsis with ordinary marks when the owner's style does not require them. Keep a symbol that carries meaning in code, math, a quotation, a link or a name.`,
		},
		{
			class: "wording",
			rule: `No repetition, off-topic material, meta introductions or unsupported praise remains; abstract nouns are replaced by the action or number the source supports; bureaucratic nominalization is not accepted as formality. The text contains no assertion unsupported by evidence and does not strengthen certainty beyond its evidence; names, exact titles, negations and uncertainty qualifiers are internally consistent, and the text does not turn a qualifier into a confident assertion. When the original text is not supplied, its absence is not a violation: judge only what the text itself shows. ${PROTECTED_EN}`,
			repair: `Only in editable prose: cut the repetition or introduction; replace hype and abstraction with what the source actually states, or delete the assertion: "It is worth noting that this is an innovative solution" -> "The service supports export", when the source supports it. Never add facts or strengthen certainty. Do not claim a fact was changed when the original text was not supplied; judge only the visible text.`,
		},
		{
			class: "syntax",
			rule: `Full sentences in prose have a subject and a predicate, but an imperative with an implied subject ("Select the file, then press the button") is not a violation; a heading and a short list item also need no predicate; a known actor is named and the voice is active, and the passive is allowed when the actor is unknown; an informative contrast is preserved; rhetorical "not X but Y", "not only X but also Y", aphorisms and repeated labeled templates are rebuilt, not renamed. ${PROTECTED_EN}`,
			repair: `Only in editable prose: rebuild the sentence as a concrete assertion with an actor and an action: "Verification is performed by the system" -> "The system verifies". Preserve an informative contrast and legal or technical meaning; keep the passive when the actor is unknown.`,
		},
		{
			class: "coherence",
			rule: `Every sentence is linked to its neighbour by cause, consequence, contrast or clarification; each paragraph has one topic; a conclusion is neither repeated nor left without a basis. ${PROTECTED_EN}`,
			repair: `Only in editable prose: connect neighbouring sentences explicitly or merge them: "The build runs on every commit. It takes 30 seconds." -> "The build runs on every commit and takes 30 seconds." Remove an orphan fact and a repeated conclusion.`,
		},
	],
};

/** Documented language names, matched after trimming and lowercasing. */
const LANGUAGE_NAMES: Record<string, "ru" | "en"> = {
	russian: "ru",
	"русский": "ru",
	"русский язык": "ru",
	english: "en",
	"английский": "en",
	"английский язык": "en",
};

/** `ru`/`en` with an optional BCP47-style region subtag: `ru`, `ru-RU`, `en-US`, `ru-419`. */
const LOCALE_TAG = /^(ru|en)(?:-[a-z]{2}|-[0-9]{3})?$/;

/**
 * The protocol for a documented language name or locale tag. An unsupported language returns
 * `undefined`; English is never selected as a fallback.
 */
export function antiSlopProtocol(language: string): AntiSlopProtocol | undefined {
	if (typeof language !== "string") return undefined;
	const normalized = language.trim().toLowerCase();
	const named = Object.hasOwn(LANGUAGE_NAMES, normalized) ? LANGUAGE_NAMES[normalized] : undefined;
	if (named === "ru") return RUSSIAN;
	if (named === "en") return ENGLISH;
	const tag = LOCALE_TAG.exec(normalized);
	if (tag === null) return undefined;
	if (tag[1] === "ru") return RUSSIAN;
	if (tag[1] === "en") return ENGLISH;
	return undefined;
}

function renderProtocol(protocol: AntiSlopProtocol): string {
	const russian = protocol.language === "ru";
	const title = russian ? "Протокол редактирования (русский)" : "Editing protocol (English)";
	const stepsLabel = russian ? "Шаги (выполняйте по порядку)" : "Steps (run in order)";
	const checksLabel = russian
		? "Встроенные проверки (каждую оценивайте отдельно на каждом фрагменте прозы)"
		: "Built-in checks (judge each independently on every prose fragment)";
	const repairLabel = russian ? "Исправление" : "Repair";
	const steps = protocol.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
	const checks = protocol.checks
		.map((check, index) => `${index + 1}. ${check.class}: ${check.rule}\n   ${repairLabel}: ${check.repair}`)
		.join("\n");
	return `${title}\n\n${stepsLabel}:\n${steps}\n\n${checksLabel}:\n${checks}`;
}

/** The bilingual protocol text appended to the registered `jev_anti_slop` description. */
export const ANTI_SLOP_PROTOCOL_GUIDANCE = [
	"Anti-slop editing protocol. Apply the protocol for the artifact's language; the built-in checks are additional to every custom rule.",
	renderProtocol(RUSSIAN),
	renderProtocol(ENGLISH),
	"Use the tool only to review the exact text: it does not rewrite the text and does not prove facts. Facts remain subject to evidence. The review asks one independently judged boolean question named protocol_<1-based-fragment>_<1-based-check> per prose fragment and built-in check; true means a violation. The language field selects the protocol: ru, en, ru-RU, en-US, Russian, English, русский, русский язык, английский and английский язык are recognized; any other value selects none. The rules and claims fields remain required; rules may be empty only for a recognized Russian or English protocol, because the built-in checks apply, and claims may be empty only for text without assertions (neither facts nor hypotheses). Any other language needs explicit custom rules. Do not treat every non-ASCII character as decorative: preserve a symbol or accent that carries meaning in a name, quotation, citation or technical record. An unavailable or inconclusive answer is not a clean result.",
].join("\n\n");
