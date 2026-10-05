// Norwegian (bokmål): the source language. Add a key here first, then in every
// other dictionary; `Messages` makes a missing key a compile error.
// See docs/i18n.md.

export const nb = {
	/** Screen-reader suffix for links that open in a new tab. */
	newTab: '(åpnes i ny fane)',
	scanner: {
		title: 'Skann eller finn en del', action: 'Skann', open: 'Skann QR-kode', close: 'Lukk skanneren',
		contents: 'Skanning og produktdetaljer',
		entry: 'Delekode', find: 'Finn del', preview: 'Kamerabilde for skanning av etiketter',
		paused: 'Skanningen er satt på pause.',
		moveAway: 'Flytt etiketten ut av rammen før du skanner den igjen.', again: 'Skann samme etikett igjen',
		retryCamera: 'Prøv kameraet igjen', retryLookup: 'Søk igjen', cancel: 'Avbryt',
		resolving: 'Henter delen …', invalid: 'Dette er ikke en etikett fra Ampoteket. Skriv inn delekoden i stedet.',
		missing: 'Fant ingen del med denne koden.', unavailable: 'Kunne ikke hente delen.',
		found: (name: string) => `Del funnet: ${name}.`,
		reviewBasket: 'Vi vet ikke om delen ble lagt i handlekurven. Sjekk handlekurven før du legger den til igjen.',
		camera: {
			closed: 'Lukket', starting: 'Starter kameraet …', scanning: 'Skanner…',
			denied: 'Kameraet er blokkert. Gi nettleseren tilgang og prøv igjen, eller skriv inn koden.',
			unavailable: 'Kameraet er ikke tilgjengelig. Du kan skrive inn koden i stedet.',
			interrupted: 'Kameraet stoppet. Start det igjen, eller skriv inn koden.',
			decoder: 'Skanneren startet ikke. Prøv igjen, eller skriv inn koden.'
		}
	},
	adminShelf: {
		emptyPosition: (position: string) => `Ledig plass ${position}`,
		moveDrawer: 'Flytt skuff',
		positionsSwapped: 'Plasseringene er byttet',
		discardChanges: 'Forkast endringer',
		saveBeforeSwap: 'Lagre eller forkast endringene før du flytter skuffer.',
		notifications: 'Varsler',
		dismissNotification: 'Lukk varsel',

		dragDrawer: 'Dra skuffen for å bytte plass',
		cancelAction: 'Avbryt',
		confirmAction: 'Bekreft',
		resizeRows: 'Dra for å endre antall rader',
		resizeCols: 'Dra for å endre antall kolonner',

		title: 'Kabinetter og skuffer | Admin | Ampoteket', heading: 'Kabinetter og skuffer',
		retryLoad: 'Prøv igjen', loading: 'Laster kabinetter og skuffer …', loadFailed: 'Kabinetter og skuffer kunne ikke lastes.',
		layoutHeading: 'Skuffeinndeling',
		layoutCount: (count: number, removed: number) => `${count === 1 ? '1 skuff' : `${count} skuffer`}.${removed ? ` ${removed === 1 ? '1 tom skuff' : `${removed} tomme skuffer`} fjernes når du lagrer.` : ''}`,
		layoutPreview: 'Forhåndsvisning av skuffeinndeling',
		resizeHandle: 'Dra for å endre skuffebredden',
		widenDrawer: 'Bredere',
		narrowDrawer: 'Smalere',
		legendAssigned: 'Har produkter',
		layoutChanged: (range: string) => `Skuffen dekker nå ${range}.`,
		emptyDrawer: 'Tom',
		splitLayout: 'Del i enkeltskuffer',
		reviewLayoutHint: 'Utkastet ditt passer ikke med den gjeldende inndelingen og må lages på nytt.',
		reviewLayout: 'Start fra den gjeldende inndelingen',
		newCabinet: 'Legg til kabinett', wall: 'Kabinetter på veggen', noCabinets: 'Ingen kabinetter ennå.',
		cabinet: (position: string) => `Kabinett ${position}`, bin: (position: string) => `Skuff ${position}`,
		cabinetMap: (position: string) => `Skuffer i kabinett ${position}`, noBins: 'Dette kabinettet har ingen skuffer.',
		grid: (rows: number, cols: number) => `${rows} rader × ${cols} kolonner`,
		contents: 'Produkter i skuffen', noProducts: 'Ingen produkter i denne skuffen.',
		inactive: 'Upublisert',
		archived: 'Arkivert',
		row: 'Rad (fra bunnen)', column: 'Kolonne (A, B, C …)',
		save: 'Lagre kabinett', saving: 'Lagrer …', cancel: 'Lukk redigering',
		currentPlacement: (position: string) => `Gjeldende plassering: ${position}`,
		placementPreview: (position: string) => `Ny plassering: ${position}`,
		moveHint: 'Sjekk at kartet stemmer med kabinettet før du lagrer.',
		archiveCabinetWithDrawers: 'Arkiver kabinett og tomme skuffer',
		archiveCabinetWithDrawersConfirm: (count: number) => `${count === 1 ? 'Én tom skuff' : `${count} tomme skuffer`} arkiveres sammen med kabinettet. Plassen blir ledig, og historikken beholdes.`,
		archiveBin: 'Arkiver tom skuff',
		archiveHint: 'Plassen blir ledig, og historikken beholdes.',
		cabinetAssignedBlocked: (count: number) => count === 1 ? 'Flytt produktet ut av kabinettet først.' : `Flytt alle ${count} produktene ut av kabinettet først, også upubliserte.`,
		moveCabinet: 'Flytt kabinett', moveTarget: 'Flytt til', move: 'Flytt',
		moveCabinetHint: 'Velg en ledig plass, eller et kabinett å bytte med.',
		wallHint: 'Sjekk at kartet stemmer med veggen.',
		movePreview: (first: string, second: string) => `${first} → ${second}`,
		swapHeading: 'Bytt plass', chooseSwap: 'Velg en annen plass', swap: 'Bytt',
		swapHint: 'Størrelsen følger med, så begge må få plass på sin nye plassering. Sjekk at kartet stemmer med virkeligheten før du bytter.',
		swapPreview: (first: string, second: string) => `${first} ↔ ${second}`,
		saved: 'Lagret', stale: 'Plasseringen er endret siden du begynte. Sjekk den nye plasseringen og prøv igjen.',
		occupied: 'Plassen er opptatt. Velg en ledig plass, eller bytt plass.',
		fit: 'Skuffene overlapper. Sjekk plassering og størrelse.',
		notEmpty: 'Kabinettet eller skuffen er ikke tom. Flytt produktene eller skuffene ut først.',
		invalid: 'Sjekk feltene. Rad og kolonne må være hele tall innenfor rutenettet.',
		unknown: 'Vi vet ikke om endringen ble lagret. Prøv igjen for å fullføre den.',
		finishChange: 'Fullfør endringen', pendingHeading: 'Ufullført endring',
		pendingCreate: (position: string) => `Opprett: ${position}`,
		pendingChange: (first: string, second: string) => `Endre: ${first} → ${second}`,
		storageUnavailable: 'Nettleseren blokkerer lagring av nettstedsdata, så du kan ikke lagre her. Tillat nettstedsdata, eller bruk en annen nettleser.',
		wrongIdentity: 'En ufullført endring tilhører en annen administrator. Logg inn som den administratoren for å fullføre den.',
		failed: 'Endringen kunne ikke lagres. Prøv igjen.'
	},
	shelfMap: {
		title: 'Hyllekart', loading: 'Henter hyllekart …',
		noJavascript: 'Kartvisningen krever JavaScript.',
		unavailable: 'Hyllekartet er utilgjengelig.',
		previousRead: 'Kartet kunne ikke oppdateres og kan være utdatert.',
		locationUnavailable: 'Fant ikke skuffen til delen i kartet. Delen kan ha blitt flyttet.',
		moved: 'Delen er flyttet.',
		keyboardHint: 'Bruk piltastene til å flytte fokus i kartet, og Enter eller mellomrom for å velge.',
		retry: 'Prøv igjen', refreshProduct: 'Last inn delen på nytt',
		empty: 'Ingen kabinetter ennå.', wall: 'Kabinetter på veggen', showWall: 'Hele veggen',
		cabinet: (cell: string) => `Kabinett ${cell}`,
		emptyDrawer: 'Tom',
		contents: (range: string) => `Deler i skuff ${range}`,
		productsLoading: 'Henter innholdet i skuffen …', productsUnavailable: 'Delelisten er utilgjengelig.',
		noProducts: 'Ingen deler i denne skuffen.',
		retryProducts: 'Prøv delelisten igjen'
	},
	help: {
		title: 'Kontakt oss | Ampoteket', description: 'Kontakt en frivillig hos Ampoteket, for eksempel om et kjøp.',
		heading: 'Kontakt oss',
		references: 'Ta et skjermbilde av kassen, eller noter beløpet, delene og referansen. Med referansen finner vi kjøpet ditt, også uten beløpet.',
		payment: 'Har du allerede betalt, ikke betal på nytt. Prøv å registrere kjøpet igjen fra samme kasse, eller kontakt en frivillig.',
		contacts: 'Kontakt en frivillig', unavailable: 'Kontaktlisten er utilgjengelig. Prøv igjen, eller spør en frivillig i verkstedet.',
		empty: 'Ingen kontaktpersoner er lagt ut ennå. Spør en frivillig i verkstedet.',
		retry: 'Prøv igjen', contactLink: (name: string) => `Kontaktlenke for ${name}`, copyDiscord: 'Kopier Discord-brukernavn', discordCopied: 'Discord-brukernavnet er kopiert',
		discord: 'Spør på Discord'
	},
	adminLabels: {
		title: 'Produktetiketter | Admin | Ampoteket', heading: 'Produktetiketter',
		selectionHeading: 'Velg fra hyllekartet',
		selectAll: 'Velg alle', clearSelection: 'Fjern utvalg', selectedDrawers: (count: number) => count === 1 ? '1 skuff valgt' : `${count} skuffer valgt`,
		wall: 'Kabinetter på veggen', emptyShelf: 'Ingen kabinetter ennå.', emptyCabinet: 'Dette kabinettet har ingen skuffer.',
		cabinet: (position: string) => `Kabinett ${position}`, selectCabinet: (position: string) => `Velg kabinett ${position}`, emptyDrawer: 'Tom',
		keyboardHint: 'Hold Shift for å velge flere på rad.',
		includeUnplaced: 'Ta med produkter uten skuff', unplaced: (count: number) => `${count} ${count === 1 ? 'produkt har' : 'produkter har'} ingen skuff. «Velg alle» tar dem med.`,
		summary: (products: number, inactive: number) => `${products} ${products === 1 ? 'produkt' : 'produkter'} valgt${inactive ? ` (${inactive} ${inactive === 1 ? 'upublisert' : 'upubliserte'})` : ''}`,
		inactiveHint: 'Upubliserte produkter får også etiketter, men kan ikke slås opp før de er publisert.',
		loading: 'Laster produkter …', unavailable: 'Produktene kunne ikke lastes.', retry: 'Prøv igjen', dimensionsHint: 'Mål en skuff, og skriv ut én testside før du skriver ut alt.',
		width: 'Etikettbredde', widthInvalid: 'Skriv en bredde fra 32 til 81 mm, med høyst én desimal.',
		generate: 'Lag etiketter', generating: 'Lager etiketter …', cancel: 'Avbryt', download: 'Last ned A4-PDF',
		previewHeading: 'Forhåndsvisning', previewHint: 'Forhåndsvisningen er ikke i faktisk størrelse.',
		printHint: 'Skriv ut på A4 i faktisk størrelse (100 %), uten «Tilpass til side». Sjekk at QR-kodene kan skannes på skuffene.',
		ready: (count: number, pages: number, columns: number, rows: number) => `${count} ${count === 1 ? 'etikett' : 'etiketter'} på ${pages} A4-ark. ${columns} ${columns === 1 ? 'kolonne' : 'kolonner'} × ${rows} ${rows === 1 ? 'rad' : 'rader'} per ark.`,
		previewAlt: (code: string, specs: string) => `Etikett for ${code}${specs ? ': ' + specs : ''}`,
		empty: 'Ingen produkter er valgt.', selectionChanged: 'Noen valgte skuffer finnes ikke lenger og er tatt ut av utvalget.',
		settingsError: 'Etikettene får ikke plass med denne bredden. Velg en annen bredde.',
		limitError: 'For mange etiketter for én fil. Velg færre produkter.',
		overflow: (code: string) => `Alt får ikke plass på etiketten for ${code}. Gjør etiketten bredere, eller kort ned spesifikasjonene til produktet.`,
		characterError: (code: string) => `Etiketten for ${code} har tegn som ikke kan skrives ut. Rett teksten på produktet.`,
		generationFailed: 'Kunne ikke lage PDF-en. Prøv igjen.'
	},
	adminProducts: {
		unset: 'Ikke oppgitt', attributeChanged: (current: string) => `Noen andre endret verdien til ${current}. Lagre igjen for å erstatte den.`,
		specificationsNotSaved: 'Noen spesifikasjoner ble ikke lagret. Se Spesifikasjoner ovenfor.',
		closeDrawer: 'Lukk skuffvelger',
		addAttribute: 'Legg til spesifikasjon',
		reviewSpecifications: 'Gjennomgå spesifikasjoner',
		saveReviewedSpecifications: 'Lagre spesifikasjonene',
		specificationMetadataKept: 'Produktet er lagret. Se over spesifikasjonene nedenfor og rett dem ved behov.',
		specificationsIncomplete: 'Produktet er lagret, men ikke alle spesifikasjonene. Prøv igjen for å fullføre.',
		invalidName: 'Angi et navn med 1–200 tegn.',
		invalidStockStep: 'Oppgi et tall større enn 0, med høyst 6 desimaler. For stk må det være et heltall.', invalidSaleStep: 'Oppgi et multiplum av lagersteget, for eksempel det samme eller det dobbelte.', invalidPrice: 'Oppgi en pris på 0 eller mer, med høyst 6 desimaler.', invalidMinimumStock: 'Oppgi 0 eller et multiplum av lagersteget.', invalidLink: 'Oppgi en nettadresse som begynner med https:// eller http://.',
		referenceRecovery: 'Fullfør endringen', referenceRecoveryStale: 'Dette er endret i mellomtiden, så den tidligere endringen ble ikke gjentatt.', referenceRecoveryRejected: 'Den tidligere endringen ble avvist.', attributeInvalid: 'Skriv et tall i enheten som vises.', specificationConflict: 'En lagret spesifikasjon passer ikke med standardoppsettet, så spesifikasjonene er låst. Kontakt den som drifter systemet.',
		typeNames: {
			RES: 'Motstander', CAP: 'Kondensatorer', DIO: 'Dioder', LED: 'Lysdioder',
			BJT: 'Bipolare transistorer', MOS: 'MOSFET-transistorer', MCU: 'Mikrokontrollere',
			SEN: 'Sensorer', MOT: 'Motorer', DRV: 'Motordrivere', CON: 'Kontakter',
			BRD: 'Prototypekort', CAB: 'Kabler', MIS: 'Diverse'
		},
		nameExamples: {
			RES: 'karbonfilm 4k7', CAP: 'keramisk 4p7', DIO: '1N4007', LED: '5 mm rød',
			BJT: 'BC547 NPN', MOS: 'IRLZ44N N-kanal', MCU: 'Arduino Nano',
			SEN: 'Temperatursensor DS18B20', MOT: 'Servomotor SG90', DRV: 'Motordriver L298N', CON: 'Stiftlist 2,54 mm 40-pin',
			BRD: 'Koblingsbrett 830 hull', CAB: 'Koblingsledninger hann–hann 20 cm', MIS: 'Batteriholder 4 × AA'
		},
		savedRefreshFailed: 'Endringen er lagret, men gjeldende opplysninger kunne ikke hentes.',
		newTitle: 'Nytt produkt | Admin | Ampoteket', noProducts: 'Ingen produkter ennå.', clearSearch: 'Fjern søk og filtre', unknownSpecification: 'Ukjent spesifikasjon', attributeRejected: 'Verdien ble avvist. Kontroller den og prøv igjen.', title: 'Produkter | Admin | Ampoteket', heading: 'Produkter',
		newProduct: 'Nytt produkt', scanProduct: 'Skann produkt', scanAgain: 'Skann igjen', scanInvalid: 'Dette er ikke en produktetikett.', scanMissing: (code: string) => `Produktkode ${code} finnes ikke.`, scanCameraUnavailable: 'Kameraet er ikke tilgjengelig. Gi nettleseren tilgang til kameraet og prøv igjen, eller søk etter produktet.', editProduct: 'Rediger produkt', onOrder: (value: string) => `${value} på bestilling`, stockLedger: 'Beholdningsendringer', back: 'Tilbake til produkter', search: 'Søk etter navn eller produktkode', stateFilter: 'Status', all: 'Alle', active: 'Publisert', inactive: 'Upublisert', lowStock: 'Lav beholdning', sortBy: 'Sorter etter', sortCurrent: (order: string) => `Sortering: ${order}`, sort: { attention: 'Trenger oppmerksomhet', counted: 'Lengst siden telling', code: 'Produktkode', name: 'Navn' }, empty: 'Ingen produkter passer søket.', loading: 'Laster …', unavailable: 'Produktene kunne ikke lastes.', missing: 'Produktet finnes ikke.', retry: 'Prøv igjen', working: 'Lagrer …', save: 'Lagre produkt', saved: 'Lagret',
		moveTitle: 'Flytte produktet?', confirmMove: 'Flytt', cancelMove: 'Avbryt',
		moveDescription: (from: string, to: string) => `Fra ${from} til ${to}. Flyttingen lagres når du velger «Lagre produkt».`,
		nameHint: 'Måleenheter formateres når du forlater feltet: 100 uF blir 100 µF. For motstander og kondensatorer holder 4k7 og 4p7.', nameNb: 'Navn på norsk', nameEn: 'Navn på engelsk', description: 'Beskrivelse', category: 'Kategori', noCategory: 'Ingen kategori', chooseCategory: 'Velg kategori', identity: 'Kategori og navn', placementHeading: 'Plassering', descriptionAndLinks: 'Beskrivelse og lenker', unit: 'Enhet', stockStep: 'Minste lagersteg', saleStep: 'Minste salgssteg', price: 'Enhetspris', minimumStock: 'Minstebeholdning', minimumStockHint: 'Med 0 vises varsel bare når beholdningen er 0 eller lavere.', datasheet: 'Lenke til datablad', purchaseUrl: 'Kjøpslenke', placement: 'Skuff', unplaced: 'Ingen skuff', chooseDrawer: 'Velg skuff', clearPlacement: 'Fjern fra skuffen', activeLabel: 'Publiser i katalogen', activeHint: 'Å avpublisere sletter ingenting.', notInDrawer: 'Ligger ikke i en skuff', locationNote: 'Plassering uten skuff', locationNoteHint: 'Vises for kjøpere, f.eks. «Filamenthylla ved 3D-printeren». Tomt felt viser «Spør en frivillig».', immutable: 'Enhet og minste lagersteg kan ikke endres senere.', inventory: 'Beholdning', inventoryUnavailable: 'Beholdningen kunne ikke lastes.', neverCounted: 'Aldri telt', openingStock: 'Beholdning', openingStockHint: 'Registreres som første telling. La feltet stå tomt hvis du ikke har talt.', openingNotCounted: 'Produktet er lagret, men beholdningen ble ikke registrert. Tell produktet.', lastCount: 'Sist telt', publicProduct: 'Se produktet i katalogen', manageShelf: 'Endre kabinetter og skuffer',
		invalid: 'Kontroller feltene og prøv igjen.', failed: 'Endringen ble avvist. Det du skrev er beholdt. Kontroller feltene og prøv igjen.', unknown: 'Vi vet ikke om lagringen gikk gjennom. Prøv igjen. Den blir ikke lagret to ganger.', stale: 'Noen andre har endret produktet mens du redigerte. Det du skrev er beholdt. Se over endringene før du lagrer.', review: 'Vis endringene', reviewed: 'Fortsett med mine endringer', currentValues: 'Lagret nå', pending: 'En tidligere endring er ikke fullført. Fullfør den før du lagrer et annet produkt.', resume: 'Fullfør endringen', storage: 'Nettleseren blokkerer lagring av nettstedsdata, så du kan ikke lagre her. Tillat nettstedsdata, eller bruk en annen nettleser.', wrongIdentity: 'En ufullført endring tilhører en annen konto. Logg inn med den kontoen for å fullføre den.', retrySave: 'Lagre igjen',
		printLabel: 'Skriv ut', printLabelName: 'Skriv ut etikett', printingLabel: 'Skriver ut …', labelPrinted: 'Etiketten er skrevet ut. Den kommer ut når du skriver ut neste etikett, eller trykk på kutteknappen på skriveren.',
		labelPrinter: { unsupported: 'Etikettskriveren kan bare brukes fra Chrome eller Edge på en datamaskin.', busy: 'Fikk ikke kontakt med etikettskriveren. Sjekk at den er koblet til og slått på, og at ikke et annet program eller en annen fane bruker den.', cover: 'Dekselet på etikettskriveren er åpent. Lukk det og prøv igjen.', tape: 'Etikettskriveren mangler tape eller har en tape den ikke kan bruke. Sett inn 18 eller 24 mm TZe-tape.', fit: 'Etiketten får ikke plass på tapen som står i. Bruk 18 eller 24 mm tape.', unconfirmed: 'Skriveren bekreftet ikke utskriften. Se etter etiketten før du prøver igjen.', failed: 'Etiketten ble ikke skrevet ut. Prøv igjen.' },
		saleAndStock: 'Salg og beholdning', attributes: 'Spesifikasjoner', attributesHint: 'SI-prefiks godtas: 27p, 4,7k, 4k7.', chooseAttribute: 'Velg spesifikasjon', yes: 'Ja', no: 'Nei', noAttributes: 'Ingen spesifikasjoner er lagret.', newDefinition: 'Ny spesifikasjon', categoryName: 'Kategorinavn', definitionLabel: 'Navn', valueType: 'Type', numberType: 'Tall', textType: 'Tekst', booleanType: 'Ja/nei', canonicalUnit: 'Grunnenhet (valgfri)', saveReference: 'Legg til', referenceSaved: 'Lagret', referenceInvalid: 'Kontroller navnet og typen og prøv igjen.', cancel: 'Lukk', location: (cabinet: string, drawer: string) => `Kabinett ${cabinet} · skuff ${drawer}`
	},
	adminOrders: {
		invalidQuantity: (step: string) => `Skriv et tall større enn 0, i trinn på ${step}.`, exceedsOutstanding: (quantity: string, unit: string) => `Skriv høyst ${quantity} ${unit}.`, invalidCost: (scale: number) => `Skriv 0 eller mer, med høyst ${scale} desimaler.`,
		title: 'Bestillinger og mottak | Admin | Ampoteket', heading: 'Bestillinger og mottak', detailTitle: (supplier: string) => `${supplier} | Bestilling | Admin | Ampoteket`, detailHeading: 'Bestilling',
		completed: 'Avsluttet', showMore: 'Vis flere',
		unknownProduct: 'Ukjent produkt', unknownActor: 'Ukjent administrator', referenceLabel: 'Leverandørreferanse', noteLabel: 'Merknad', supplierSkuLabel: 'Leverandørens varenummer',
		newOrder: 'Ny bestilling', unplannedReceipt: 'Registrer mottak uten bestilling', closeEntry: 'Lukk skjema', newProductFromOrder: 'Opprett nytt produkt', orders: 'Bestillinger', orderLines: 'Bestillingslinjer', lineNumber: (number: number) => `Linje ${number}`,
		loading: 'Laster bestillinger …', unavailable: 'Bestillinger og mottak kunne ikke lastes.', detailUnavailable: 'Bestillingen kunne ikke lastes.', retry: 'Prøv igjen', empty: 'Ingen bestillinger ennå.', missing: 'Bestillingen finnes ikke.',
		supplier: 'Leverandør', reference: 'Leverandørreferanse (valgfri)', placedAt: 'Bestilt', recordedAt: 'Registrert', recordedByLabel: 'Registrert av', recordedBy: (name: string) => `Registrert av ${name}`,
		note: 'Merknad (valgfri)', additionalCost: 'Frakt og andre kostnader', product: 'Produkt', selectProduct: 'Velg produkt', searchProduct: 'Søk etter navn eller produktkode', noProductMatches: 'Ingen produkter passer søket.',
		quantity: 'Antall', unitCost: 'Innkjøpspris per enhet', purchaseUrl: 'Kjøpslenke (valgfri)', openPurchaseUrl: 'Åpne lenken (ny fane)', supplierSku: 'Leverandørens varenummer (valgfritt)', openLines: (number: number) => number === 1 ? '1 åpen linje' : `${number} åpne linjer`,
		allNeeded: (count: number) => `Alle ${count}`, closeNeeded: 'Lukk', doneNeeded: 'Ferdig', needsOrdering: 'Må bestilles', selectAll: 'Velg alle', onOrder: (value: string) => `${value} i bestilling`, removeLine: 'Fjern linje', recordOrder: 'Lagre bestilling', recordReceipt: 'Registrer mottaket', openReceipt: 'Registrer mottak', closeReceipt: 'Lukk mottak',
		receiptSelection: 'Velg minst én linje eller skriv inn mottatt antall.',
		scanProduct: 'Skann produkt', scanNext: 'Skann neste', scanInvalid: 'Dette er ikke en produktetikett.', scanNotOrdered: (code: string) => `${code} står ikke på bestillingen, eller er allerede mottatt.`, scanMatch: (code: string) => `Produktkode ${code} står på bestillingen. Sjekk antallet før du registrerer.`, noOutstanding: 'Alt på denne bestillingen er mottatt eller kansellert.', differentQuantity: 'Endre antall', receivedQuantity: 'Mottatt antall',
		cameraDenied: 'Kameraet er blokkert. Gi nettleseren tilgang og prøv igjen, eller kryss av linjene nedenfor.', cameraInterrupted: 'Kameraet stoppet. Prøv igjen, eller kryss av linjene nedenfor.', cameraUnavailable: 'Kameraet er ikke tilgjengelig. Prøv igjen, eller kryss av linjene nedenfor.',
		sourceNote: 'Kilde, for eksempel giver', working: 'Registrerer …', saving: 'Lagrer …', storageUnavailable: 'Nettleseren blokkerer lagring av nettstedsdata, så du kan ikke lagre her. Tillat nettstedsdata, eller bruk en annen nettleser.',
		wrongIdentity: 'En ufullført endring tilhører en annen konto. Logg inn med den kontoen for å fullføre den.', invalidDate: 'Oppgi et gyldig tidspunkt. Det kan ikke ligge fram i tid.', ambiguousDate: 'Dette klokkeslettet fantes to ganger fordi klokka ble stilt tilbake. Velg hvilket du mener.', offset: 'Før eller etter at klokka ble stilt tilbake?', chooseOffset: 'Velg', beforeClockChange: 'Før', afterClockChange: 'Etter',
		unknown: 'Vi vet ikke om registreringen gikk gjennom. Prøv igjen. Den blir ikke registrert to ganger.', invalid: 'Kontroller feltene og prøv igjen.',
		pendingElsewhere: 'En tidligere endring er ikke fullført.', resumePending: 'Fullfør endringen', retryReceipt: 'Registrer mottaket igjen', retryOrder: 'Lagre bestillingen igjen', retryCancel: 'Kanseller igjen', retryReverse: 'Angre kanselleringen igjen', conflict: 'Noe ble endret i mellomtiden, så ingenting ble registrert. Se over og prøv igjen.',
		ordered: 'Bestilt', received: 'Mottatt', cancelled: 'Kansellert', outstanding: 'Gjenstår',
		cancelHeading: 'Kanseller det som gjenstår', cancelSelected: 'Kanseller valgt mengde', cancelConfirm: 'Mengden blir ikke lenger ventet inn. Beholdningen endres ikke, og kanselleringen kan angres én gang.', cancel: 'Avbryt', reverseCancellation: 'Angre kansellering', reverseConfirm: 'Mengden blir ventet inn igjen. Beholdningen endres ikke. Denne kanselleringen kan bare angres én gang, og handlingen kan ikke angres.', reason: 'Begrunnelse', cancelReason: 'Begrunnelse for kansellering',
		receiptHistory: 'Mottakshistorikk', cancellationHistory: 'Kanselleringer', receivedAt: 'Mottatt',
		editMetadata: 'Rediger opplysninger', editLineMetadata: (name: string, line: number) => `Rediger opplysninger for ${name}, linje ${line}`, supplierName: 'Leverandørnavn', saveOrderMetadata: 'Lagre endringer', saveLineMetadata: 'Lagre linje',
		invalidMetadata: 'Kontroller opplysningene og prøv igjen.', metadataUnknown: 'Vi vet ikke om endringen ble lagret. Sjekk bestillingen før du prøver igjen.', metadataSaved: 'Lagret',
		metadataConflict: 'Noen andre endret bestillingen mens du redigerte. Se de oppdaterte opplysningene, og lagre igjen for å beholde endringene dine.', reviewMetadata: 'Se over bestillingen',
		receiptRecorded: 'Registrert', cancellationRecorded: 'Kansellert', reversalRecorded: 'Angret', cancellationEntry: 'Kansellering', reversalEntry: 'Angret kansellering',
		historyCorrection: 'Korrigering', unplannedHistory: 'Mottak uten bestilling'
	},
	adminStock: {
		reasonRequired: 'Skriv en begrunnelse.',
		invalidQuantity: (step: string, signed: boolean) => signed ? `Skriv en endring ulik 0, i trinn på ${step}.` : `Skriv et tall større enn 0, i trinn på ${step}.`,
		title: 'Beholdningsendringer | Admin | Ampoteket', heading: 'Beholdningsendringer',
		stock: 'Registrert beholdning', history: 'Beholdningshistorikk',
		withdraw: 'Uttak', adjust: 'Justering', correct: 'Korriger', correctMovement: (movement: string) => `Korriger ${movement}`, unknownMovement: 'Ukjent beholdningsendring', actionHeading: 'Registrer beholdningsendring', kind: 'Type', movement: 'Bevegelse som korrigeres', chooseMovement: 'Velg bevegelse',
		quantity: 'Antall', delta: 'Endring i antall (+/−)', counted: 'Opptalt mengde', reason: 'Begrunnelse',
		recount: 'Produktet er telt etter denne bevegelsen, så du må telle det på nytt. Registrer kjente mottak, uttak og kjøp først, og la skuffen være i ro mens du teller.', pauseConfirmed: 'Skuffen har vært i ro mens jeg talte på nytt.', reviewed: 'Jeg har sett over historikken',
		orderProgress: (received: string, outstanding: string) => `Bestillingslinje: mottatt ${received}, gjenstår ${outstanding}`,
		corrects: (movement: string) => `Korrigerer ${movement}`, priorCorrections: 'Tidligere korrigeringer', count: 'Telling',
		kindLabels: { receipt: 'Mottak', sale: 'Registrert kjøp', count: 'Telling', adjustment: 'Justering', withdrawal: 'Uttak' },
		load: 'Laster beholdningshistorikk …', unavailable: 'Beholdningshistorikken kunne ikke lastes.', noProducts: 'Ingen produkter er registrert.', retry: 'Prøv igjen', invalid: 'Kontroller antallet og begrunnelsen. Antallet må følge produktets trinn.',
		working: 'Registrerer …', save: 'Registrer', retrySame: 'Registrer igjen', saved: 'Registrert',
		unknown: 'Vi vet ikke om endringen ble registrert. Prøv igjen. Den blir ikke registrert to ganger.', stale: 'Beholdningen har endret seg i mellomtiden. Se over historikken før du korrigerer.',
		recountRequired: 'Produktet er telt etter denne bevegelsen. Tell det på nytt før du korrigerer.',
		storage: 'Nettleseren blokkerer lagring av nettstedsdata, så du kan ikke lagre her. Tillat nettstedsdata, eller bruk en annen nettleser.', wrongIdentity: 'En ufullført endring tilhører en annen konto. Logg inn med den kontoen for å fullføre den.',
		pendingElsewhere: 'Fullfør den ufullførte endringen på et annet produkt først.', noteHint: 'Ikke skriv personopplysninger. Begrunnelsen blir liggende i historikken.'
	},
	adminCounts: {
		closeCount: 'Lukk telling',
		title: 'Tellinger | Admin | Ampoteket', heading: 'Tellinger',
		startHeading: 'Ny telling', batchTitle: 'Navn på tellingen', start: 'Start telling', retryStart: 'Start tellingen igjen', batches: 'Alle tellinger',
		starting: 'Starter …', recording: 'Registrerer …', finishing: 'Avslutter …',
		loading: 'Laster tellinger …', loadingStock: 'Laster beholdning …', retryLoad: 'Prøv igjen', empty: 'Ingen tellinger ennå.',
		loadFailed: 'Tellingene kunne ikke lastes.', detailLoadFailed: 'Tellingen kunne ikke lastes.', stockLoadFailed: 'Beholdningen kunne ikke lastes.',
		startFailed: 'Tellingen kunne ikke startes. Prøv igjen.', finishFailed: 'Tellingen kunne ikke avsluttes. Prøv igjen.', saveFailed: 'Tellingen kunne ikke registreres. Prøv igjen.',
		storageUnavailable: 'Nettleseren blokkerer lagring av nettstedsdata, så du kan ikke lagre her. Tillat nettstedsdata, eller bruk en annen nettleser.',
		wrongIdentity: 'En ufullført endring tilhører en annen administrator. Logg inn som den administratoren for å fullføre den.',
		pendingElsewhere: 'En tidligere endring er ikke fullført.', resumePending: 'Fullfør endringen',
		unknownStart: 'Vi vet ikke om tellingen ble startet. Prøv igjen. Det blir ikke opprettet to.',
		unknownFinish: 'Vi vet ikke om tellingen ble avsluttet. Prøv igjen.',
		unknown: 'Vi vet ikke om opptellingen ble registrert. Prøv igjen. Den blir ikke registrert to ganger.',
		owner: 'Ansvarlig', you: '(deg)', unknownAdmin: 'Ukjent administrator', unknownProduct: 'Ukjent produkt',
		batchStates: { owner: 'Åpen', other: 'Åpen', abandoned: 'Forlatt', finished: 'Avsluttet' },
		singleCount: (code: string) => `Telling av ${code}`,
		started: (time: string) => `Startet ${time}`, finished: (time: string, name: string) => `Avsluttet ${time} av ${name}`,
		detailTitle: (name: string) => `${name} | Admin | Ampoteket`, detailHeading: 'Telling', missing: 'Tellingen finnes ikke.',
		matchingCounts: 'Registrer også opptellinger uten avvik.',
		countProduct: 'Tell produktet', beginCount: 'Begynn telling',
		countPrerequisite: 'Registrer kjente mottak, uttak og kjøp først. Opptellingen oppdaterer beholdningen med en gang.',
		recorded: 'Registrert beholdning', lastCount: (time: string) => `Sist telt ${time}`,
		observed: 'Opptalt mengde', expected: 'Forventet mengde', quantityHint: (step: string, unit: string) => `I trinn på ${step} ${unit}. Skriv 0 hvis det ikke er noen igjen.`,
		invalidQuantity: (step: string) => `Oppgi 0 eller mer, i trinn på ${step}.`,
		difference: 'Avvik', enterQuantity: 'Oppgi opptalt mengde', note: 'Merknad (valgfri)', noteHint: 'Ikke skriv personopplysninger. Merknaden blir liggende i historikken.',
		differenceNote: 'Forklar gjerne avviket.', pauseConfirmed: 'Skuffen har vært i ro mens jeg talte.', saveCount: 'Registrer opptelling', retryCount: 'Registrer tellingen igjen',
		savedBadge: 'Registrert', savedDetail: (quantity: string, difference: string) => `${quantity}, avvik ${difference}`,
		stale: 'Beholdningen endret seg mens du talte, så opptellingen ble ikke registrert. Tell på nytt.',
		rejectedObservation: (quantity: string, unit: string) => `Ikke registrert: ${quantity} ${unit}.`,
		closedDuringCount: 'Tellingen ble avsluttet før opptellingen ble registrert. Start en ny telling og tell på nytt.',
		ownerOnly: 'Bare den ansvarlige kan telle i eller avslutte denne tellingen.', ownerChanged: 'Den ansvarliges tilgang er endret. Se over tellingen på nytt.',
		recount: 'Tell på nytt', countAgain: 'Tell igjen', retryRead: 'Prøv igjen',
		chooseProduct: 'Velg et produkt å telle', noProducts: 'Ingen produkter passer til søket.',
		drawerFilter: 'Avgrens til skuff', allProducts: 'Vis alle produkter', drawerProducts: 'Produkter i skuffen', countedHere: 'Telt',
		finish: 'Avslutt telling', closeAbandoned: 'Avslutt forlatt telling', finishExplanation: 'Avslutning endrer ikke beholdningen.',
		abandonedExplanation: 'Den ansvarlige har ikke lenger tilgang. Avslutning endrer ikke beholdningen eller opptellingene som er gjort. Vil du telle videre, start din egen telling.',
		closureReason: 'Begrunnelse for avslutning', closureReasonHint: 'Begrunnelsen blir liggende i historikken. Ikke skriv personopplysninger.',
		finishDialog: 'Du kan ikke registrere flere opptellinger etter at tellingen er avsluttet. Beholdningen endres ikke.',
		closeDialog: 'Tellingen avsluttes, og begrunnelsen blir liggende i historikken. Beholdningen og opptellingene som er gjort endres ikke.',
		retryFinish: 'Avslutt tellingen igjen',
		history: 'Registrerte opptellinger', noObservations: 'Ingen opptellinger ennå.'
	},
	adminStatistics: {
		title: 'Statistikk | Admin | Ampoteket', overviewTitle: 'Oversikt | Admin | Ampoteket', heading: 'Statistikk', details: 'Produktdetaljer',
		period: 'Siste 30 dager',
		basis: 'Basert på registrerte kjøp. Betalinger kontrolleres ikke, og senere korrigeringer er ikke med.',
		saleCount: 'Kjøp', value: 'Salgsverdi', quantitySold: 'Solgt mengde',
		attention: 'Trenger oppmerksomhet',
		noAttention: 'Ingen produkter er tomme eller under minstebeholdningen.', attentionList: (count: string) => `Se alle ${count} med lav beholdning`,
		openCounts: 'Åpne tellinger', noOpenCounts: 'Ingen åpne tellinger.', allCounts: 'Se alle tellinger', allStatistics: 'Se statistikk',
		openOrder: 'Start en bestilling', topProducts: 'Mest solgt etter salgsverdi',
		sold: (value: string) => `${value} solgt`,
		chartTitle: 'Registrert salg per dag', dailyData: 'Daglige tall',
		maximum: (value: string) => `Høyeste dag: ${value}`,
		emptySales: 'Ingen registrerte kjøp i denne perioden.',
		loading: 'Laster …', unavailable: 'Statistikken kunne ikke lastes.', overviewUnavailable: 'Oversikten kunne ikke lastes.', unknown: 'Utilgjengelig', retry: 'Prøv igjen',
	},
	adminAudit: {
		title: 'Endringslogg | Admin | Ampoteket', heading: 'Endringslogg',
		description: 'Endringer i produkter, plassering, bestillinger, tellinger, administratorer og kontaktopplysninger.',
		related: 'Relaterte sider', loading: 'Laster …', unavailable: 'Endringsloggen kunne ikke lastes.',
		empty: 'Ingen endringer er registrert.', more: 'Vis eldre endringer', retry: 'Prøv igjen',
		actor: 'Utført av', details: 'Vis endringer', before: 'Før', after: 'Etter',
		system: 'System', selfService: 'Selvbetjent kjøp', unknownAdmin: 'Ukjent administrator', unresolved: 'Ukjent', unknownSubject: 'Ukjent oppføring',
		none: 'Ikke angitt', yes: 'Ja', no: 'Nei', published: 'Publisert', unpublished: 'Upublisert', active: 'Aktiv', inactive: 'Inaktiv', archived: 'Arkivert', inUse: 'I bruk',
		valueTypes: { number: 'Tall', text: 'Tekst', boolean: 'Ja/nei' },
		fields: {
			code: 'Produktkode', name_nb: 'Norsk navn', name_en: 'Engelsk navn', name: 'Navn', display_name: 'Navn', title: 'Tittel', description: 'Beskrivelse',
			category_id: 'Kategori', bin_id: 'Skuff', cabinet_id: 'Kabinett', product_id: 'Produkt', attribute_id: 'Spesifikasjon', order_id: 'Bestilling',
			unit_code: 'Enhet', stock_step: 'Beholdningstrinn', sale_step: 'Kjøpstrinn', sale_unit_price_nok: 'Salgspris', minimum_stock: 'Minstebeholdning',
			location_note: 'Plasseringsmerknad', datasheet_url: 'Datablad', purchase_url: 'Bestillingslenke', is_active: 'Tilgang', is_published: 'Publisering',
			label: 'Navn', outer_row: 'Rad på veggen', outer_col: 'Kolonne på veggen', inner_row: 'Rad i kabinettet', inner_col: 'Kolonne i kabinettet', inner_rows: 'Rader', inner_cols: 'Kolonner', row_span: 'Høyde i celler', col_span: 'Bredde i celler', is_archived: 'Arkivering',
			symbol: 'Symbol', is_discrete: 'Hele enheter', value_type: 'Verditype', canonical_unit: 'Måleenhet', number_value: 'Verdi', text_value: 'Verdi', boolean_value: 'Verdi',
			supplier_name: 'Leverandør', supplier_reference: 'Leverandørreferanse', placed_at: 'Bestilt', additional_cost_nok: 'Tilleggskostnad', note: 'Merknad', ordered_quantity: 'Bestilt mengde', unit_cost_nok: 'Innkjøpspris', supplier_sku: 'Leverandørens produktkode',
			owner_id: 'Ansvarlig administrator', created_by: 'Registrert av', started_at: 'Startet', finished_at: 'Avsluttet', finished_by: 'Avsluttet av', finish_reason: 'Årsak til avslutning',
			email: 'E-post', phone: 'Telefon', contact_url: 'Kontaktlenke', discord: 'Discord-brukernavn', responsibility: 'Ansvarsområde', display_order: 'Rekkefølge'
		},
		tables: { staff_members: 'Administrator', help_contacts: 'Kontakt', units: 'Enhet', categories: 'Kategori', cabinets: 'Kabinett', bins: 'Skuff', products: 'Produkt', attribute_definitions: 'Spesifikasjonstype', product_attributes: 'Produktspesifikasjon', purchase_orders: 'Bestilling', purchase_order_lines: 'Bestillingslinje', count_batches: 'Telling', checkout_contacts: 'Kjøperens kontaktopplysning' },
		actions: { INSERT: 'Opprettet', UPDATE: 'Endret', DELETE: 'Slettet', CONTACT_CLEARED: 'Kontaktopplysning slettet' }
	},
	adminMembers: {
		title: 'Administratorer | Admin | Ampoteket', heading: 'Administratorer', list: 'Alle administratorer',
		accessHint: 'Alle administratorer kan endre produkter og beholdning, invitere nye administratorer og deaktivere andres tilgang.',
		name: 'Navn', invite: 'Inviter administrator', resend: 'Send invitasjon på nytt', reactivate: 'Aktiver tilgang',
		active: 'Aktiv', inactive: 'Inaktiv', awaitingSetup: 'Venter på passordoppsett', accountRemoved: 'Konto fjernet', you: '(deg)',
		deactivate: 'Deaktiver tilgang', forMember: (name: string) => `for ${name}`, deactivateNamed: (name: string) => `Deaktiver tilgangen til ${name}`,
		inviting: 'Inviterer …', activating: 'Aktiverer …', deactivating: 'Deaktiverer …',
		deactivateHint: (name: string) => `${name} mister admintilgangen med én gang. Tidligere endringer blir liggende i historikken.`,
		confirmDeactivate: 'Deaktiver', close: 'Lukk',
		unavailable: 'Administratorene kunne ikke lastes.',
		feedback: {
			invited: 'Invitasjonen er sendt. Mottakeren kan følge lenken i e-posten for å sette opp passord.',
			existing_account: 'Admintilgangen er aktiv. Personen har allerede en konto og kan logge inn med den.',
			deactivated: 'Admintilgangen er deaktivert. Historikken er bevart.',
			deactivationSuperseded: 'Deaktiveringen ble registrert, men en annen administrator har siden aktivert tilgangen igjen.',
			emailFailed: 'Admintilgangen er lagret, men invitasjonen kunne ikke sendes. Prøv igjen, eller lukk og send invitasjonen fra kontolisten senere.',
			unknown: 'Vi vet ikke om endringen ble fullført. Prøv igjen med den samme forespørselen.',
			invalidInput: 'Sjekk navnet og e-postadressen.',
			notFound: 'Fant ikke administratoren. Kontoen kan ha blitt fjernet.',
			conflict: 'Forespørselen stemmer ikke med en tidligere forespørsel. Prøv igjen.',
			superseded: 'Kontoen eller tilgangen er endret. Se gjennom kontodetaljene før du inviterer på nytt.',
			rateLimited: 'For mange invitasjoner på kort tid. Vent litt og prøv igjen.',
			failed: 'Endringen kunne ikke sendes. Prøv igjen.',
			self: 'Du kan ikke deaktivere din egen admintilgang.'
		}
	},
	admin: {
		breadcrumb: 'Brødsmulesti',
		toggleSidebar: 'Vis eller skjul sidepanelet', closeSidebar: 'Lukk sidepanelet',
		title: 'Admin | Ampoteket', heading: 'Admin', overview: 'Oversikt', cancel: 'Avbryt', navigation: 'Adminoppgaver', noScript: 'Slå på JavaScript for å bruke admin.',
		loading: 'Laster …', unavailable: 'Utilgjengelig akkurat nå. Prøv igjen.',
		signInRequired: 'Logg inn som administrator.', signIn: 'Logg inn', signOut: 'Logg ut', retry: 'Prøv igjen', continue: 'Fortsett', continueToAdmin: 'Gå til admin',
		signingIn: 'Logger inn …', sending: 'Sender …', saving: 'Lagrer …', continuing: 'Fortsetter …', retrying: 'Prøver igjen …', lookingUp: 'Slår opp …', recording: 'Registrerer …', saved: 'Lagret',
		groups: { daily: 'Daglig arbeid', shelf: 'Hylle og etiketter', reports: 'Rapporter', access: 'Hjelp og tilgang' },
		accessUnavailable: 'Admintilgangen kunne ikke sjekkes.',
		noAccess: 'Denne kontoen har ikke admintilgang. Be en administrator om tilgang.',
		revoked: 'Admintilgangen din er fjernet, så du kan ikke lagre flere endringer.',
		signedInAs: (name: string) => `Innlogget som ${name}.`,

		signInTitle: 'Logg inn | Admin | Ampoteket', email: 'E-postadresse', password: 'Passord', forgotPassword: 'Glemt passord?',
		signInErrors: {
			invalid: 'Kunne ikke logge inn. Sjekk e-postadressen og passordet og prøv igjen.',
			rateLimited: 'For mange forsøk. Vent litt og prøv igjen.',
			unavailable: 'Innloggingen svarer ikke akkurat nå. Sjekk nettforbindelsen og prøv igjen.'
		},
		passwordTitle: 'Passord | Admin | Ampoteket', passwordHeading: 'Sett opp eller tilbakestill passord',
		newPassword: 'Nytt passord', passwordHint: 'Minst 8 tegn.', repeatPassword: 'Gjenta nytt passord', savePassword: 'Lagre passord', sendReset: 'Send passordlenke',
		resetSent: 'Hvis kontoen finnes, får du en e-post med en passordlenke.', invalidCallback: 'Passordlenken virker ikke. Be om en ny, og åpne den i samme nettleser.',
		authFailed: 'Noe gikk galt. Prøv igjen.', passwordMismatch: 'Passordene er ikke like.', backToSignIn: 'Tilbake til innlogging',
		recoveryTitle: 'Finn kjøp | Admin | Ampoteket', recoveryHeading: 'Finn kjøp',
		recoveryIntro: 'Brukes når en kjøper sier at de har betalt, men kjøpet ikke ble registrert.',
		reference: 'Hjelpereferanse', referenceHint: 'Reservereferansen virker også.', lookup: 'Slå opp', invalidReference: 'Skriv inn hele hjelpereferansen.',
		checkoutMissing: 'Fant ikke noe kjøp med denne referansen. Sjekk at den er riktig, og ikke lag et erstatningskjøp.',
		operationFailed: 'Noe gikk galt. Prøv igjen.', savedCheckout: 'Kjøpet',
		created: 'Opprettet', quantity: 'Antall', unitPrice: 'Enhetspris', total: 'Totalt',
		registered: 'Registrert', unregistered: 'Ikke registrert',
		paymentUnverified: 'Vipps-betalinger blir ikke verifisert.',
		recoverAction: 'Registrer det opprinnelige kjøpet', identificationWarning: 'Sjekk at referansen, produktene, beløpet og tidspunktet stemmer med det kjøperen forteller. Er du usikker, stopp og undersøk nærmere. Ikke lag et nytt kjøp eller et manuelt uttak.',
		countWarning: 'Ble produktene tatt før en telling, stemmer ikke den tellingen lenger. Da må skuffen telles på nytt etter registreringen.',
		countSteps: ['Registrer kjøpet først. Ikke juster beholdningen for hånd, og ikke endre den gamle tellingen.', 'La ingen ta ut eller fylle på i skuffen. Registrer andre kjøp du vet venter.', 'Tell skuffen på nytt og registrer tellingen før den tas i bruk igjen.'],
		reason: 'Begrunnelse', reasonHint: 'Kort forklaring, uten personopplysninger.',
		identified: 'Jeg er sikker på at dette er riktig kjøp, og sørger for ny telling om det trengs.', retryRecovery: 'Prøv å registrere igjen',
		recoveryUnknown: 'Vi vet ikke om registreringen gikk gjennom. Prøv igjen, eller finn kjøpet på nytt for å sjekke. Ikke lag et nytt uttak.',
		storageUnavailable: 'Nettleseren blokkerer lagring av nettstedsdata, så du kan ikke lagre her. Tillat nettstedsdata, eller bruk en annen nettleser.',
		commandIdentity: 'En annen konto har en ufullført endring i denne nettleseren. Logg inn med den kontoen for å fullføre den.',
		buyerContact: 'Kjøperens kontaktopplysning', contactWarning: 'Vis bare når du trenger det. Kjøperen har skrevet dette selv, så det beviser ikke betaling eller hvem kjøpet tilhører.',
		showContact: 'Vis kontaktopplysning', noContact: 'Ingen kontaktopplysning er lagret.', confirmClear: 'Kontaktopplysningen slettes for godt. Kjøpet beholdes.', clearContact: 'Slett kontaktopplysning', contactErased: 'Slettet',
		directoryTitle: 'Kontaktsiden | Admin | Ampoteket', directoryHeading: 'Kontaktsiden',
		directoryConsent: 'Publiser bare kontaktopplysninger personen har sagt ja til å vise på kontaktsiden. Tidligere versjoner blir liggende i historikken.',
		newContact: 'Ny kontakt', viewPublic: 'Se kontaktsiden', noDirectoryContacts: 'Ingen kontakter er lagt inn.', published: 'Publisert', unpublished: 'Ikke publisert',
		edit: 'Rediger', editHeading: 'Rediger kontakt', contactName: 'Visningsnavn', contactEmail: 'E-post (valgfritt)', contactPhone: 'Telefon (valgfritt)', contactUrl: 'Kontaktlenke (valgfritt)', contactResponsibility: 'Ansvar (valgfritt)', contactDiscord: 'Discord-brukernavn (valgfritt)',
		publishContact: 'Vis kontakten på den offentlige kontaktsiden', atLeastOneContact: 'En publisert kontakt trenger Discord-brukernavn, e-post, telefon eller lenke.',
		saveContact: 'Lagre kontakt', retrySave: 'Lagre igjen', directoryUnavailable: 'Kontaktene kunne ikke lastes.', contactInvalid: 'Sjekk feltene. E-post, telefon og lenke må være gyldige, Discord-brukernavnet har bare små bokstaver, tall, _ og ., og lenken må starte med https://.',
		reviewContact: 'Vis den nye versjonen', reviewedContact: 'Fortsett med mine endringer', contactStale: 'Noen andre endret kontakten mens du redigerte. Endringene dine står fortsatt i skjemaet. Se den nye versjonen før du lagrer.', contactUnknown: 'Vi vet ikke om kontakten ble lagret. Prøv å lagre igjen.',
		moveContactUp: (name: string) => `Flytt ${name} opp`, moveContactDown: (name: string) => `Flytt ${name} ned`,
		contactMoved: (name: string, position: number, total: number) => `${name} er nummer ${position} av ${total}.`,
		orderStale: 'Noen andre endret listen. Den er oppdatert nå, så prøv å flytte igjen.'
	},

	/** Singular display labels; the database names remain category/filter identities. */
	specificationLabels: {
		resistance: 'Resistans', capacitance: 'Kapasitans', voltage: 'Spenning', current: 'Strøm',
		power: 'Effekt', tolerance: 'Toleranse', package: 'Kapsling', model: 'Modell', colour: 'Farge',
		pitch: 'Pinneavstand', pins: 'Antall pinner', polarised: 'Polarisert', interface: 'Grensesnitt', step_angle: 'Stegvinkel'
	},
	categories: {
		resistors: 'Motstand', capacitors: 'Kondensator', diodes: 'Diode', leds: 'Lysdiode',
		transistors: 'Transistor', 'bipolar transistors': 'Bipolar transistor', mosfets: 'MOSFET-transistor', miscellaneous: 'Diverse', controllers: 'Kontroller', sensors: 'Sensor', motors: 'Motor',
		'motor drivers': 'Motordriver', connectors: 'Kontakt', prototyping: 'Prototypeutstyr', cable: 'Kabel'
	},
	catalog: {
		title: 'Delekatalog | Ampoteket',
		description: 'Finn elektronikkdeler etter navn, kategori, spesifikasjoner eller koden på etiketten.',
		heading: 'Delekatalog',
		searchLabel: 'Søk etter deler', search: 'Søk', filters: 'Filtre', filtersSelected: (count: number) => `Filtre (${count})`,
		searchPlaceholder: 'Navn eller delekode',
		filterTitle: 'Filtrer deler', closeFilters: 'Lukk filtre', filterOptions: 'Filtervalg',
		category: 'Kategorier', allCategories: 'Vis alle kategorier',
		locations: 'Kabinett eller skuff', locationsChanged: 'Noen valgte plasseringer finnes ikke lenger. Fjern utvalget og velg på nytt.',
		chooseCategory: 'Velg en kategori for å filtrere på spesifikasjoner.',
		singleCategoryForSpecifications: 'Velg bare én kategori for å filtrere på spesifikasjoner.',
		cancel: 'Avbryt', applyFilters: 'Vis resultater',
		min: 'Fra og med', max: 'Til og med',
		fromValue: (value: string) => `Fra ${value}`, upToValue: (value: string) => `Til ${value}`,
		betweenValues: (from: string, to: string) => `${from}–${to}`,
		noLowerBound: 'Ingen nedre grense', noUpperBound: 'Ingen øvre grense',
		anyValue: 'Alle verdier', emptyValue: '(tom verdi)',
		noScript: 'Filtrene krever JavaScript. Søk og bla fungerer uten.',
		browseUnfiltered: 'Bla i alle deler',
		invalidCode: 'Delekoden i lenken er ugyldig. Søk etter delen i stedet.',
		loadingSearch: 'Laster flere deler …',
		loadingFilters: 'Laster filtre …', filtersUnavailable: 'Filtrene er utilgjengelige. Prøv igjen.',
		unavailable: 'Katalogen er utilgjengelig. Prøv igjen.',
		previousRead: 'Katalogen kunne ikke oppdateres. Det som vises, kan være utdatert.',
		retry: 'Prøv igjen', clearFilters: 'Fjern alle filtre',
		results: 'Deler', noMatches: 'Ingen deler passer søket.',
		emptyCatalog: 'Ingen deler i katalogen ennå.', endOfBrowse: 'Du har kommet til slutten av katalogen.',
		pagination: 'Katalogsider', next: 'Neste side', firstPage: 'Til første side',
		showMore: 'Vis flere', shownCount: (count: number) => count === 1 ? '1 del vises.' : `${count} deler vises.`,
		errors: {
			invalidQuery: 'Søkelenken er ugyldig. Fjern filtrene og søk på nytt.',
			unknownCategory: 'Kategorien i søkelenken finnes ikke lenger. Velg en annen kategori eller fjern filtrene.',
			unknownAttribute: 'En spesifikasjon i søkelenken finnes ikke i denne kategorien. Fjern filtrene og velg på nytt.',
			invalidFilter: 'Sjekk spesifikasjonsfiltrene og prøv igjen.',
			missingCursor: 'Katalogen er endret siden forrige side. Gå til første side.'
		}
	},
	shop: {
		unavailable: 'Utilgjengelig',
		stockPositive: 'På lager',
		stockLow: 'Lite igjen',
		stockZero: 'Tomt',
		stockNegative: 'Negativ beholdning',
		yes: 'Ja',
		no: 'Nei',
		quantity: (value: string, unit: string) => `${value} ${unit}`,
		perUnit: (unit: string) => `per ${unit}`,
		/** Labels for the two location chips on the one shelf wall: cabinet →
		    drawer. The values are spreadsheet-style cell references from
		    #lib/format. */
		cabinet: 'Kabinett',
		drawer: 'Skuff',
		/** Parts stored outside the drawer wall show a staff note, or askStaff. */
		location: 'Plassering',
		askStaff: 'Spør en frivillig',
		at: 'i'
	},
	/** Site-wide metadata that is not visible on any page. */
	social: {
		imageAlt: 'Ampoteket sett fra gata om kvelden, med det lysende AMPOTEKET-skiltet i vinduet og verkstedet innenfor.'
	},
	locale: {
		/** Shown in the language picker, in the language itself. */
		name: 'Norsk'
	},
	header: {
		skip: 'Hopp til innholdet',
		home: 'Ampoteket, forsiden',
		menu: 'Hovedmeny',
		/** Name of the phone header's menu button. The state comes from aria-expanded. */
		menuToggle: 'Meny',
		language: 'Språk',
		parts: 'Delekatalog',
		cart: 'Handlekurv',
		cartLoading: ', laster',
		cartUnavailable: ', må sjekkes',
		admin: 'Admin',
		contact: 'Kontakt oss',
		discord: 'Ampoteket på Discord',
		instagram: 'Ampoteket på Instagram',
		cartLines: (n: number) => (n === 1 ? ', 1 del' : `, ${n} deler`)
	},
	footer: {
		links: 'Lenker',
		about: 'Drives av The Resistance og RoboMEK. Foto og utvikler: Hjalmar Karlsen.',
		help: 'Kontakt oss',
		privacy: 'Personvern',
		discord: 'Discord'
	},
	product: {
		title: (name: string) => `${name} | Ampoteket`,
		back: 'Til delekatalogen',
		unavailableTitle: 'Delen er utilgjengelig',
		unavailable: 'Vi kunne ikke hente opplysninger om denne delen. Prøv igjen.',
		retry: 'Prøv igjen',
		step: (value: string, unit: string) => `Selges per ${value} ${unit}.`,
		quantity: 'Antall',
		already: (value: string, unit: string) => `Du har ${value} ${unit} i handlekurven.`,
		add: 'Legg i handlekurven',
		adding: 'Legger til …',
		added: 'Lagt til i handlekurven.',
		cart: 'Se handlekurven',
		specifications: 'Spesifikasjoner',
		description: 'Beskrivelse',
		datasheet: 'Åpne datablad',
		stockNote: 'Lagerbeholdningen kan avvike fra det som ligger i skuffen. Har du funnet delen, kan du likevel legge den i handlekurven.',
		noJavascript: 'Slå på JavaScript for å legge deler i handlekurven.'
	},
	cart: {
		title: 'Handlekurv | Ampoteket',
		heading: 'Handlekurv',
		description: 'Se gjennom delene og antallet du vil kjøpe.',
		lines: (count: number) => count === 1 ? '1 del' : `${count} deler`,
		browse: 'Finn flere deler',
		empty: 'Handlekurven er tom.',
		storage: 'Handlekurven kan ikke lagres i denne nettleseren. Tillat informasjonskapsler og nettstedsdata for denne siden, og prøv igjen.',
		invalid: 'Handlekurven kan ikke leses. Kan du ha betalt for eller tatt med deler, ikke tøm den. Spør en frivillig.',
		reset: 'Tøm handlekurven',
		resetQuestion: 'Tøm bare hvis du verken har betalt for eller tatt med noen av delene.',
		resetConfirm: 'Ingenting betalt eller tatt med, tøm',
		cancel: 'Avbryt',
		resetDone: 'Handlekurven er tømt.',
		retry: 'Prøv igjen',
		locked: 'Du har et kjøp i gang',
		recovery: 'Har du betalt, trykk «Fortsett kjøpet» nederst og så «Jeg har betalt». Ikke betal på nytt.',
		requestReference: 'Hjelpereferanse',
		checkoutReference: 'Hjelpereferanse',
		backupReference: 'Klargjøringsreferanse (reserve)',
		quantity: 'Antall',
		decrease: (name: string) => `Reduser antall av ${name}`,
		increase: (name: string) => `Øk antall av ${name}`,
		step: (value: string, unit: string) => `Selges per ${value} ${unit}.`,
		saving: 'Lagrer …',
		removeFor: (name: string) => `Fjern ${name}`,
		saved: 'Antallet er lagret.',
		removed: 'Delen er fjernet fra handlekurven.',
		factsLoading: 'Henter opplysninger om delen …',
		factsUnavailable: 'Opplysninger om delen er utilgjengelige. Prøv igjen for å endre antallet.',
		missing: 'Delen finnes ikke lenger i katalogen. Fjern den fra handlekurven.',
		unknown: 'Lagret del',
		stockNote: 'Lagerbeholdningen er veiledende. Delene er ikke reservert.',
		lineTotal: 'Sum',
		total: 'Totalt',
		totalUnavailable: 'Utilgjengelig',
		noJavascript: 'Handlekurven krever JavaScript. Du kan fortsatt bla i delekatalogen.',
		errors: {
			quantity: 'Skriv et gyldig antall.',
			limit: 'Handlekurven kan ha høyst 200 forskjellige deler.',
			changed: 'Handlekurven ble endret i en annen fane. Sjekk antallet og prøv igjen.',
			locked: 'Du har et kjøp i gang. Handlekurven kan ikke endres før det er ferdig.',
			invalid: 'Handlekurven kan ikke leses.',
			storage: 'Vi fikk ikke bekreftet at endringen ble lagret. Sjekk handlekurven og prøv igjen.'
		}
	},
	checkout: {
		title: 'Kasse | Ampoteket',
		heading: 'Ditt kjøp',
		loading: 'Henter kjøpet …',
		preparing: 'Lagrer kjøpet …',
		prepared: 'Kjøpet er lagret.',
		confirming: 'Vi vet ikke ennå om kjøpet ble registrert. Ikke betal på nytt.',
		registered: 'Kjøpet er registrert.',
		needsAttention: 'Kjøpet er ikke fullført.',
		registeredNote: 'Betalingen sjekkes ikke her. Vi stoler på deg.',
		contact: 'Telefon eller e-post (valgfritt)',
		reviewNeeded: 'Se over delene i handlekurven før du går videre.',
		proceed: 'Gå til kassen',
		resume: 'Fortsett kjøpet',
		retry: 'Prøv igjen',
		retryConfirm: 'Prøv å registrere igjen',
		quantity: 'Antall',
		unitPrice: 'Pris per enhet',
		lineTotal: 'Sum',
		total: 'Til sammen',
		paymentHeading: 'Betal med Vipps',
		recipient: 'Vippsnummer',
		paymentInstructions: 'Betal beløpet ovenfor i Vipps og lim inn referansen som melding, så finner vi kjøpet ditt. Kom så tilbake hit for å registrere kjøpet.',
		vippsMessage: 'Melding i Vipps',
		copyMessage: 'Kopier',
		messageCopied: 'Referansen er kopiert',
		openVipps: 'Åpne Vipps',
		qrAlt: 'QR-kode for å åpne Vipps til mottaker 47322',
		paid: 'Jeg har betalt, registrer kjøpet',
		free: 'Fullfør kjøpet',
		pending: 'Registrerer kjøpet …',
		help: 'Kontakt en frivillig',
		helpInstructions: 'Ta et skjermbilde av siden, så kan en frivillig finne kjøpet. Har du betalt, noter beløpet og ikke betal på nytt.',
		setAside: 'Endre handlekurven',
		setAsideQuestion: 'Gjør dette bare hvis du verken har betalt eller tatt med deg noen av delene.',
		setAsideConfirm: 'Ingenting betalt eller tatt med, endre handlekurven',
		setAsideDone: 'Nå kan du endre handlekurven.',
		otherAttempt: 'Du har et annet kjøp i gang. Fullfør det først, eller fortsett med dette i stedet.',
		resumeSaved: 'Fortsett dette kjøpet',
		receiptEmail: 'E-post for kvittering',
		sendReceipt: 'Send kvittering',
		sendingReceipt: 'Sender …',
		receiptSent: 'Sendt',
		receiptSentTo: (email: string) => `Kvitteringen er sendt til ${email}.`,
		receiptInvalid: 'Skriv en gyldig e-postadresse.',
		receiptFailed: 'Kvitteringen ble ikke sendt. Prøv igjen om litt.',
		newPurchase: 'Start et nytt kjøp',
		backToCart: 'Til handlekurven',
		noJavascript: 'Kassen trenger JavaScript. Spør en frivillig om hjelp hvis du ikke kan slå det på.',
		errors: {
			storage: 'Nettleseren kunne ikke lagre kjøpet. Prøv igjen, eller spør en frivillig om hjelp.',
			missing: 'Kjøpet finnes ikke i denne nettleseren. Åpne det i nettleseren der du startet det, eller spør en frivillig.',
			credentials: 'Kjøpet kan ikke åpnes i denne nettleseren. Ikke start et nytt kjøp for de samme delene. Vis referansen til en frivillig.',
			payload: 'Kjøpet kan bare lagres fra fanen der du startet det. Gå tilbake dit, eller spør en frivillig.',
			unavailable: 'Kjøpet er utilgjengelig akkurat nå. Prøv igjen om litt.',
			conflict: 'Kjøpet ble endret i en annen fane. Prøv igjen for å se hvordan det står nå.',
			empty: 'Legg deler i handlekurven før du fortsetter.',
			contact: 'Telefon eller e-post kan ha høyst 300 tegn.',
			rejected: 'Noen av delene eller antallene ble ikke godtatt. Spør en frivillig før du endrer handlekurven.'
		}
	},
	home: {
		title: 'Ampoteket | Studentenes elektronikkverksted på OsloMet',
		description:
			'Ampoteket er elektronikkverkstedet i Pilestredet 35, drevet av studenter. Loddeplasser, oscilloskop, to 3D-printere og en delehylle du handler fra selv.',
		hero: {
			title: 'Lodd, bygg og hent delene selv',
			lede: 'Loddeplasser, oscilloskop, to 3D‑printere og en hylle med deler, midt i Pilestredet 35.',
			parts: 'Se delekatalogen',
			soon: 'Nettbutikken åpner snart',
			place: 'PS126 · Pilestredet 35',
			map: 'Vis rommet i MazeMap',
			clock: 'Klokka i Oslo',
			clockTime: (time: string) => `Klokka i Oslo: ${time}`,
			open: 'Åpent',
			closed: 'Stengt',
			hours: 'OsloMets åpningstider',
			hoursSource: 'https://student.oslomet.no/apningstider',
		},
		photos: {
			storefront:
				'Ampoteket sett fra gata om kvelden: det lysende AMPOTEKET-skiltet henger i vinduet, og innenfor står arbeidsbord, loddeplasser og instrumenter.',
			workshop:
				'Verkstedet om kvelden: skjermene på multimetre, signalgeneratorer og oscilloskop lyser langs arbeidsbenken, og en arbeidslampe står tent ved vinduet.',
			bench:
				'En arbeidsbenk i mørket: et multimeter viser 001.921 mVDC, og et koblingsbrett for digitalteknikk lyser rødt i forgrunnen.',
			drawers:
				'Veggen med deleskuffer: blå kabinetter med merkede, gjennomsiktige skuffer fulle av komponenter.'
		},
		about: {
			title: 'Dette er Ampoteket',
			body2:
				'Jobb med egne prosjekter, bruk utstyr du ikke har hjemme, og heng med folk som holder på med det samme.',
			quote:
				'I stedet for å vente i ukevis på deler, kan du ofte finne det du trenger her og komme i gang på minutter.',
			quoteBy: 'Eirik Holm, tidligere leder for Ampoteket',
			sourceText: 'Les saken hos OsloMet',
			facts: [
				{ term: 'Drives av', value: 'The Resistance og RoboMEK', chips: ['The Resistance', 'RoboMEK'] },
				{ term: 'Fagmiljø', value: 'MEK, OsloMet' }
			],
			storyTitle: 'Bygget av studenter',
			story: [
				'Studentene fant rommet, kartla behovene og overbeviste OsloMet',
				'100\u00a0000 kroner i strategimidler for utdanningskvalitet',
				'Nytt taklys, et stort arbeidsbord og gjenbrukt utstyr, satt opp på dugnad'
			],
			opened: 'Åpnet 26. februar 2026',
			openedStep: 'Åpnet',
			openedLed: '26.02.2026',
			openingQuote: 'Der jeg så ledninger og kaos, så studentene muligheter og moro.',
			openingQuoteBy: 'Silje Fekjær, prorektor for utdanning, under åpningen'
		},
		voices: {
			title: 'Bygg det du brenner for',
			quotes: [
				{
					text: 'Å ha dette verkstedet gjør at jeg kan utvikle prosjekter jeg brenner for, teste kretser og få mer praktisk forståelse av det vi lærer.',
					by: 'Alexander Rosenkilde, førsteårsstudent i elektronikk, under åpningen',
					tags: ['Kretser', '3D-printing']
				},
				{
					text: 'Jeg har jobbet med musikkproduksjon, og vil bruke Ampoteket til å lage utstyr som forforsterkere og miksere.',
					by: 'Magnus Weden, tredjeårsstudent, under åpningen',
					tags: ['Forforsterkere', 'Miksere']
				}
			],
			tagsLabel: 'Prosjekter'
		},
		facilities: {
			title: 'Utstyr og aktiviteter',
			gearTitle: 'Utstyr',
			gear: [
				'Loddeplasser, strømforsyninger og oscilloskop',
				'To Bambu Lab P2S 3D-printere og utstyr for prototyping',
				'Arbeidsstasjoner, felles arbeidsbord og PC-er',
				'Deler du kan kjøpe på stedet'
			],
			eventsTitle: 'Planlagte aktiviteter',
			events: [
				'Kurs i lodding og kretskort',
				'Prosjektkvelder',
				'Faglige verksteder'
			],
			printerAlt: '3D-modell av Bambu Lab P2S-printeren, sett skrått forfra, uten logo',
			solderingAlt: '3D-modell av en loddestasjon med loddebolt, holder og kretskort',
		},
		shelf: {
			title: 'Delehylla',
			body1:
				'Hver del har sin egen skuff, og på skuffen sitter en lapp med delekode og QR-kode. Lappen er alt du trenger for å finne delen igjen.',
			labelIntro: 'Eksempel på lapp:',
			labelName: '22 kΩ',
			steps: [
				{
					n: '1',
					title: 'Finn delen',
					text: 'Skann QR-koden på skuffen, eller slå opp koden i delekatalogen.'
				},
				{
					n: '2',
					title: 'Betal i Vipps',
					text: 'Legg delene i handlekurven og gå til kassen. Der ser du beløpet du skal betale i Vipps.'
				},
				{
					n: '3',
					title: 'Registrer kjøpet',
					text: 'Trykk «Jeg har betalt». Da trekkes delene fra lageret, så vi ser når vi må bestille mer.'
				}
			],
			stepLabel: (n: string) => `Steg ${n}`,
			retryStrong: 'Mistet du nettet etter at du betalte?',
			retry: 'Gå til handlekurven og fortsett kjøpet der. Ikke betal på nytt. Spør en frivillig hvis det ikke går.'
		},
		find: {
			codeLabel: 'Delekode',
			codeHint: 'Bokstaver, tall og bindestrek, for eksempel RES-00026',
			codeSubmit: 'Åpne delen',
			shelfTitle: 'Hyllekart', shelfOpen: 'Finn i hylla', shelfClose: 'Lukk hyllekartet',
		},
		who: {
			title: 'Hvem kan bruke Ampoteket?',
			groups: [
			{
				title: 'Studenter',
				text: 'Studerer du elektro, er dette rommet for deg. Bli med i The Resistance eller RoboMEK hvis du vil bruke det.'
			},
			{
				title: 'Frivillige',
					text: 'Ampoteket drives av frivillige studenter som holder rommet og hylla i orden. Vil du hjelpe til, snakk med The Resistance eller RoboMEK.'
				}
			],
			hours: 'Åpent hverdager 06–22 og helger 08–22, med adgangskort og PIN etter kl. 16, ifølge',
			discord: {
				title: 'Ampoteket på Discord',
				text: 'Still spørsmål og del prosjekter med andre som bruker verkstedet.',
				join: 'Bli med på Discord',
				online: (n: number) => `${n} pålogget`,
				more: (n: number) => `og ${n} til`,
				status: { online: 'pålogget', idle: 'inaktiv', dnd: 'ikke forstyrr' },
				loading: 'Henter antall pålogget …',
				unavailable: 'Antall pålogget er utilgjengelig.',
				retry: 'Prøv igjen'
			}
		}
	},
	notFound: {
		title: 'Finner ikke siden | Ampoteket',
		heading: 'Finner ikke siden',
		body: 'Leter du etter en del? Sjekk at koden er riktig.',
		catalog: 'Åpne delekatalogen',
		home: 'Til forsiden',
		errorTitle: 'Siden kunne ikke lastes | Ampoteket',
		errorHeading: 'Siden kunne ikke lastes',
		errorBody: 'Feilen ligger hos oss. Handlekurven din ligger lagret i denne nettleseren, så ingenting er tapt.',
		retry: 'Prøv igjen',
		help: 'Få hjelp',
		soonTitle: 'Nettbutikken åpner snart | Ampoteket',
		soonHeading: 'Nettbutikken åpner snart',
		soonBody: 'Delekatalogen, handlekurven og betalingen er ikke åpnet ennå.'
	},
	/** Receipt email, rendered on the server. The one email carries both languages. */
	receipt: {
		subject: 'Kvittering fra Ampoteket',
		preheader: 'Kvittering for kjøpet ditt.',
		heading: 'Kvittering fra Ampoteket',
		lead: (date: string) => `Kjøpet ditt er registrert ${date}.`,
		total: 'Totalt',
		note: 'Betalingen sjekkes ikke av oss. Dette er en kvittering på registreringen, ikke på betalingen.',
		reference: 'Hjelpereferanse',
		referenceHelp: 'Trenger du hjelp med kjøpet, vis referansen til en frivillig.',
		help: 'Hjelp med kjøpet',
		address: 'Ampoteket, Pilestredet 35, Oslo'
	},
	privacy: {
		title: 'Personvern | Ampoteket',
		description: 'Hva Ampoteket lagrer om deg som kjøper, hvor det ligger, og hvordan du får kontaktopplysningen din slettet.',
		heading: 'Personvern',
		lede: 'Ampoteket drives av The Resistance og RoboMEK. Du trenger ingen konto for å handle, og vi bruker ingen sporing, analyse eller reklame.',
		sections: [
			{
				title: 'I nettleseren din',
				paragraphs: [
					'Handlekurven og et kjøp du har startet lagres i denne nettleseren, ikke på en konto. Tømmer du nettstedsdata, forsvinner de derfra.',
					'Når du går til kassen, setter vi én informasjonskapsel som kobler kjøpet til nettleseren din. Den holder i ett år og brukes bare til kjøpet.'
				]
			},
			{
				title: 'Kontaktopplysning i kassen',
				paragraphs: [
					'Telefon eller e-post er valgfritt. Vi bruker den bare til å finne kjøpet ditt hvis noe går galt, og bare frivillige med innlogging kan se den.',
					'Den lagres skilt fra lagerhistorikken. Har du ikke registrert kjøpet, slettes den etter 90 dager. Etter registrering blir den liggende til du ber om at den slettes.'
				]
			},
			{
				title: 'Kvittering på e-post',
				paragraphs: [
					'Ber du om kvittering, sender vi den med tjenesten Resend. Adressen brukes til den ene utsendingen og lagres ikke hos oss.'
				]
			},
			{
				title: 'Discord på forsiden',
				paragraphs: [
					'Oversikten over hvem som er pålogget hentes av serveren vår, så nettleseren din kontakter aldri Discord. Ingenting om deg sendes dit.'
				]
			},
			{
				title: 'Hvor dataene ligger',
				paragraphs: [
					'Nettsiden kjøres på Cloudflare. Kjøp og lager ligger i en Supabase-database i Stockholm.'
				]
			},
			{
				title: 'Få kontaktopplysningen slettet',
				paragraphs: [
					'Be en frivillig om å slette den. Ta med hjelpereferansen fra kassen, så finner de riktig kjøp. Kjøpet og lagerhistorikken beholdes, uten kontaktopplysningen.'
				]
			}
		],
		help: 'Kontakt en frivillig'
	}
};

/** The shape every dictionary must have. Norwegian is the source of truth. */
export type Messages = typeof nb;
