import type { ParsedJob } from './jobsch';
import type { JobCountry } from './types';

/**
 * Public ATS job boards. These endpoints exist so aggregators and job boards can read a company's
 * openings, so they need no key, no VPN, and carry no terms conflict - unlike the page-fetching
 * sources. Employers carry the volume here; staffing agencies publish only their own internal
 * hiring to these boards, which is why the list is mostly direct employers.
 *
 * Every entry below was verified live before being added. To add a company, find its slug and
 * confirm one of the platform URLs returns postings, then append it here.
 *
 * The 2026-09-14 additions (#56) started from leads in a public Common Crawl-derived company list
 * (github.com/Feashliaa/job-board-aggregator). That list is CC BY-NC 4.0, so nothing was copied
 * from it: each lead was checked against the employer's own feed, and a board was added only if,
 * on that day, it answered, held at least one posting located in the Netherlands or Switzerland,
 * and that posting was long enough (900+ characters) for the language gate to judge. 254 leads
 * gave 237 that passed; 15 more were removed on review because they are not direct employers —
 * third-party, referral and alumni boards, LinkedIn-wrapped postings, recruitment and
 * executive-search networks. Workday boards were not considered: their endpoint is the careers
 * page's own data call rather than a feed published for aggregators. Replacing the lead list with
 * our own discovery is #59.
 */
export type AtsPlatform = 'greenhouse' | 'lever' | 'recruitee' | 'ashby' | 'personio' | 'teamtailor' | 'workable';

export interface AtsCompany {
  slug: string;
  name: string;
  platform: AtsPlatform;
  /** Home market. Postings are still routed by their own location, so an international company feeds both countries. */
  country: Exclude<JobCountry, 'unknown'>;
}

export const atsCompanies: AtsCompany[] = [
  // Netherlands
  { slug: 'adyen', name: 'Adyen', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'dept', name: 'DEPT', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'bloomreach', name: 'Bloomreach', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'catawiki', name: 'Catawiki', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'flowtraders', name: 'Flow Traders', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'fourthline', name: 'Fourthline', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'octagon', name: 'Octagon Professionals', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'mollie', name: 'Mollie', platform: 'ashby', country: 'netherlands' },
  { slug: 'bynder', name: 'Bynder', platform: 'ashby', country: 'netherlands' },
  { slug: 'bunq', name: 'bunq', platform: 'recruitee', country: 'netherlands' },
  { slug: 'channable', name: 'Channable', platform: 'recruitee', country: 'netherlands' },
  { slug: 'vandebron', name: 'Vandebron', platform: 'recruitee', country: 'netherlands' },
  { slug: 'nmbrs', name: 'Nmbrs', platform: 'recruitee', country: 'netherlands' },
  { slug: 'adecco', name: 'Adecco', platform: 'recruitee', country: 'netherlands' },
  { slug: 'ohpen', name: 'Ohpen', platform: 'personio', country: 'netherlands' },
  { slug: 'randstad', name: 'Randstad', platform: 'personio', country: 'netherlands' },
  { slug: 'framer', name: 'Framer', platform: 'personio', country: 'netherlands' },
  // Switzerland
  { slug: 'onrunning', name: 'On', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'proton', name: 'Proton', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'scandit', name: 'Scandit', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'frontify', name: 'Frontify', platform: 'ashby', country: 'switzerland' },
  { slug: 'smallpdf', name: 'Smallpdf', platform: 'ashby', country: 'switzerland' },
  { slug: 'climeworks', name: 'Climeworks', platform: 'recruitee', country: 'switzerland' },
  { slug: 'elca', name: 'ELCA', platform: 'recruitee', country: 'switzerland' },
  { slug: 'sika', name: 'Sika', platform: 'personio', country: 'switzerland' },
  { slug: 'swisslinx', name: 'Swisslinx', platform: 'personio', country: 'switzerland' },
  // International scale-ups and mid-size firms hiring across NL/CH
  { slug: 'elastic', name: 'Elastic', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'conclusion', name: 'Conclusion', platform: 'recruitee', country: 'netherlands' },
  { slug: 'valtech', name: 'Valtech', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'centric', name: 'Centric', platform: 'recruitee', country: 'netherlands' },
  { slug: 'greenchoice', name: 'Greenchoice', platform: 'recruitee', country: 'netherlands' },
  { slug: 'miro', name: 'Miro', platform: 'ashby', country: 'netherlands' },
  { slug: 'bird', name: 'Bird (MessageBird)', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'hackerone', name: 'HackerOne', platform: 'ashby', country: 'netherlands' },
  { slug: 'crisp', name: 'Crisp', platform: 'ashby', country: 'netherlands' },
  { slug: 'leapsome', name: 'Leapsome', platform: 'ashby', country: 'netherlands' },
  { slug: 'typeform', name: 'Typeform', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'fairphone', name: 'Fairphone', platform: 'personio', country: 'netherlands' },
  { slug: 'trivago', name: 'Trivago', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'dashmote', name: 'Dashmote', platform: 'recruitee', country: 'netherlands' },
  { slug: 'flink', name: 'Flink', platform: 'ashby', country: 'netherlands' },
  { slug: 'contentful', name: 'Contentful', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'seenons', name: 'Seenons', platform: 'recruitee', country: 'netherlands' },
  { slug: 'xebia', name: 'Xebia', platform: 'personio', country: 'netherlands' },
  // Master-data and data-governance vendors: closest match to the derived CV roles
  { slug: 'collibra', name: 'Collibra', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'reltio', name: 'Reltio', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'atlan', name: 'Atlan', platform: 'ashby', country: 'netherlands' },
  { slug: 'starburst', name: 'Starburst', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'montecarlodata', name: 'Monte Carlo', platform: 'ashby', country: 'netherlands' },
  { slug: 'xomnia', name: 'Xomnia', platform: 'recruitee', country: 'netherlands' },
  { slug: 'bearingpoint', name: 'BearingPoint', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'statworx', name: 'statworx', platform: 'personio', country: 'switzerland' },
  // Supply chain and freight technology
  { slug: 'flexport', name: 'Flexport', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'project44', name: 'project44', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'fourkites', name: 'FourKites', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'forto', name: 'Forto', platform: 'ashby', country: 'netherlands' },
  // Swiss corporates and telecom
  { slug: 'swisscom', name: 'Swisscom', platform: 'recruitee', country: 'switzerland' },
  { slug: 'sunrise', name: 'Sunrise', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'comet', name: 'Comet Group', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'basilea', name: 'Basilea Pharmaceutica', platform: 'personio', country: 'switzerland' },
  // Added 2026-09-14 (#56): 170 Netherlands employers, each verified live
  { slug: 'airapps', name: 'AirApps', platform: 'ashby', country: 'netherlands' },
  { slug: 'airwallex', name: 'Airwallex', platform: 'ashby', country: 'netherlands' },
  { slug: 'altura', name: 'Altura', platform: 'ashby', country: 'netherlands' },
  { slug: 'axelera', name: 'Axelera AI', platform: 'ashby', country: 'netherlands' },
  { slug: 'contentoo', name: 'Contentoo', platform: 'ashby', country: 'netherlands' },
  { slug: 'dandy', name: 'Dandy', platform: 'ashby', country: 'netherlands' },
  { slug: 'dapper', name: 'Dapper Labs', platform: 'ashby', country: 'netherlands' },
  { slug: 'dash0', name: 'Dash0', platform: 'ashby', country: 'netherlands' },
  { slug: 'decagon', name: 'Decagon', platform: 'ashby', country: 'netherlands' },
  { slug: 'deeploy', name: 'Deeploy', platform: 'ashby', country: 'netherlands' },
  { slug: 'duna', name: 'Duna', platform: 'ashby', country: 'netherlands' },
  { slug: 'elevenlabs', name: 'ElevenLabs', platform: 'ashby', country: 'netherlands' },
  { slug: 'equal1', name: 'Equal1', platform: 'ashby', country: 'netherlands' },
  { slug: 'everai', name: 'Everai', platform: 'ashby', country: 'netherlands' },
  { slug: 'eye-security', name: 'Eye Security', platform: 'ashby', country: 'netherlands' },
  { slug: 'feedbackfruits', name: 'FeedbackFruits', platform: 'ashby', country: 'netherlands' },
  { slug: 'fiducial', name: 'Fiducial', platform: 'ashby', country: 'netherlands' },
  { slug: 'hawkeyeinnovations', name: 'Hawk-Eye Innovations', platform: 'ashby', country: 'netherlands' },
  { slug: 'horizon3ai', name: 'Horizon3.ai', platform: 'ashby', country: 'netherlands' },
  { slug: 'i3d', name: 'i3D.net', platform: 'ashby', country: 'netherlands' },
  { slug: 'langchain', name: 'LangChain', platform: 'ashby', country: 'netherlands' },
  { slug: 'lightspeedhq', name: 'Lightspeed', platform: 'ashby', country: 'netherlands' },
  { slug: 'monumental', name: 'Monumental', platform: 'ashby', country: 'netherlands' },
  { slug: 'mytomorrows', name: 'myTomorrows', platform: 'ashby', country: 'netherlands' },
  { slug: 'polarsteps', name: 'Polarsteps', platform: 'ashby', country: 'netherlands' },
  { slug: 'quantware', name: 'QuantWare', platform: 'ashby', country: 'netherlands' },
  { slug: 'reaktor', name: 'Reaktor', platform: 'ashby', country: 'netherlands' },
  { slug: 'robin-radar', name: 'Robin Radar', platform: 'ashby', country: 'netherlands' },
  { slug: 'satispay', name: 'Satispay', platform: 'ashby', country: 'netherlands' },
  { slug: 'sensorfact', name: 'Sensorfact', platform: 'ashby', country: 'netherlands' },
  { slug: 'snowflake', name: 'Snowflake', platform: 'ashby', country: 'netherlands' },
  { slug: 'stream', name: 'Stream', platform: 'ashby', country: 'netherlands' },
  { slug: 'tandem-health', name: 'Tandem Health', platform: 'ashby', country: 'netherlands' },
  { slug: 'tebi', name: 'Tebi', platform: 'ashby', country: 'netherlands' },
  { slug: 'vio', name: 'Vio', platform: 'ashby', country: 'netherlands' },
  { slug: 'vistar', name: 'Vistar Media', platform: 'ashby', country: 'netherlands' },
  { slug: 'wetravel', name: 'WeTravel', platform: 'ashby', country: 'netherlands' },
  { slug: 'testendouble', name: 'ACT Group', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'akqa', name: 'AKQA', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'aloyoga', name: 'ALO', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'alphafmcroles', name: 'Alpha Financial Markets Consulting', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'andurilindustries', name: 'Anduril Industries', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'artefact', name: 'Artefact', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'asm', name: 'ASM', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'atolls', name: 'Atolls', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'autoscout24', name: 'AutoScout24', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'avantium', name: 'Avantium', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'avepoint', name: 'AvePoint', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'awin', name: 'Awin', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'axon', name: 'Axon', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'workatbackbase', name: 'Backbase', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'betterhelp', name: 'BetterHelp', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'bursonglobalcareers', name: 'Burson', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'butternutbox', name: 'Butternut Box', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'carbonrobotics', name: 'Carbon Robotics', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'nlcventures', name: 'CAREERS AT NLC', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'castaigroupinc', name: 'Cast AI', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'catonetworks', name: 'Cato Networks', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'celonis', name: 'Celonis', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'chainguard', name: 'Chainguard', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'classpass', name: 'ClassPass', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'clevr', name: 'CLEVR', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'cofraholding', name: 'COFRA Holding', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'connectwise', name: 'ConnectWise', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'coveoen', name: 'Coveo', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'creativefabrica', name: 'Creative Fabrica', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'davinciderivatives', name: 'Da Vinci', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'databricks', name: 'Databricks', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'datadog', name: 'Datadog', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'devrev', name: 'DevRev', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'doitintl', name: 'DoiT', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'drweng', name: 'DRW', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'ebury', name: 'Ebury', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'edgeconnex', name: 'EdgeConneX', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'ethernovia', name: 'Ethernovia, Inc.', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'feverup', name: 'FeverUp', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'fireblocks', name: 'Fireblocks', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'fusionworldwide', name: 'Fusion Worldwide', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'gelbergroup', name: 'Gelber Group', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'genscript', name: 'GenScript/ProBio', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'geotab', name: 'Geotab', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'gigs', name: 'Gigs', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'gitlab', name: 'GitLab', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'grafanalabs', name: 'Grafana Labs', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'gymshark', name: 'Gymshark', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'hellofresh', name: 'HelloFresh', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'hightouch', name: 'Hightouch', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'housinganywhere', name: 'HousingAnywhere Group', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'imc', name: 'IMC', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'intersystems', name: 'InterSystems', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'jamf', name: 'Jamf', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'jetbrains', name: 'JetBrains', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'jumptrading', name: 'Jump Trading', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'levelworks', name: 'Level.works', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'lucanetgroup', name: 'Lucanet Group', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'lucidmotors', name: 'Lucid Motors', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'mavensecuritiesholdingltd', name: 'Maven', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'mewssystems', name: 'Mews', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'modulrfinance', name: 'Modulr', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'mongodb', name: 'MongoDB', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'monks', name: 'Monks', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'mozilla', name: 'Mozilla', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'nebius', name: 'Nebius', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'highmetric', name: 'NewRocket', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'nielenschuman', name: 'Nielen Schuman', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'nozominetworks', name: 'Nozomi Networks', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'numagroupgmbh', name: 'Numa', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'ogilvy', name: 'Ogilvy', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'okx', name: 'OKX', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'mediabrands', name: 'Omnicom Media', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'onetrust', name: 'OneTrust', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'optiverus', name: 'Optiver', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'payhawkio', name: 'Payhawk', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'teampicnic', name: 'Picnic', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'planetlabs', name: 'Planet', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'pqshield', name: 'PQShield', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'precisionmedicinegroup', name: 'Precision Medicine Group', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'qphox', name: 'QphoX', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'quixquantumbv', name: 'QuiX Quantum BV', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'radixexperienced', name: 'Radix Trading Experienced Job Board', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'reddit', name: 'Reddit', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'redwoodsoftware', name: 'Redwood Software', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'roblox', name: 'Roblox', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'sentinellabs', name: 'SentinelOne', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'sharkninjaoperatingllc', name: 'SharkNinja', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'shipbobinc', name: 'ShipBob, Inc.', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'sohohouseco', name: 'Soho House & Co.', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'speechify', name: 'Speechify', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'spektrum', name: 'Spektrum', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'stockx', name: 'StockX', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'suitsupply', name: 'Suitsupply', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'sumup', name: 'SumUp', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'supermetricsoy', name: 'Supermetrics', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'surepay', name: 'SurePay', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'systemiq', name: 'Systemiq', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'telnyx54', name: 'Telnyx', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'thefork', name: 'The Fork', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'thequalitygroupgmbh2', name: 'The Quality Group', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'thequalitygroupgmbh1', name: 'The Quality Group GmbH', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'thoughtworks', name: 'Thoughtworks', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'togetherai', name: 'Together AI', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'toogoodtogo', name: 'Too Good To Go', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'travix', name: 'Travix', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'tripadvisor', name: 'Tripadvisor', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'trustpilot', name: 'Trustpilot', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'velocityelectronics', name: 'Velocity Electronics', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'verisign', name: 'Verisign', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'gympass', name: 'Wellhub', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'wizinc', name: 'Wiz, Inc.', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'workato', name: 'Workato', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'workwize', name: 'Workwize', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'wppmedia', name: 'WPP Media', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'zscaler', name: 'Zscaler', platform: 'greenhouse', country: 'netherlands' },
  { slug: 'thinkahead', name: 'AHEAD', platform: 'lever', country: 'netherlands' },
  { slug: 'bloomon', name: 'Bloomon', platform: 'lever', country: 'netherlands' },
  { slug: 'brooksrunning', name: 'Brooks Running', platform: 'lever', country: 'netherlands' },
  { slug: 'companial', name: 'Companial', platform: 'lever', country: 'netherlands' },
  { slug: 'extremenetworks', name: 'Extreme Networks', platform: 'lever', country: 'netherlands' },
  { slug: 'fresha', name: 'Fresha', platform: 'lever', country: 'netherlands' },
  { slug: 'insify', name: 'Insify', platform: 'lever', country: 'netherlands' },
  { slug: 'mendix', name: 'Mendix', platform: 'lever', country: 'netherlands' },
  { slug: 'mujininc', name: 'Mujin', platform: 'lever', country: 'netherlands' },
  { slug: 'poki', name: 'Poki', platform: 'lever', country: 'netherlands' },
  { slug: 'protolabs', name: 'Protolabs', platform: 'lever', country: 'netherlands' },
  { slug: 'rws', name: 'RWS', platform: 'lever', country: 'netherlands' },
  { slug: 'sambatv', name: 'Samba TV', platform: 'lever', country: 'netherlands' },
  { slug: 'shieldai', name: 'Shield AI', platform: 'lever', country: 'netherlands' },
  { slug: 'trevipay', name: 'TreviPay', platform: 'lever', country: 'netherlands' },
  { slug: 'getwingapp', name: 'Wing', platform: 'lever', country: 'netherlands' },
  { slug: 'yuno', name: 'Yuno', platform: 'lever', country: 'netherlands' },
  // Added 2026-09-14 (#56): 52 Switzerland employers, each verified live
  { slug: 'adaptyv', name: 'Adaptyv Bio', platform: 'ashby', country: 'switzerland' },
  { slug: 'arrakis', name: 'Arrakis', platform: 'ashby', country: 'switzerland' },
  { slug: 'benchling', name: 'Benchling', platform: 'ashby', country: 'switzerland' },
  { slug: 'blockstream', name: 'Blockstream', platform: 'ashby', country: 'switzerland' },
  { slug: 'blp-digital', name: 'BLP Digital', platform: 'ashby', country: 'switzerland' },
  { slug: 'cradlebio', name: 'Cradlebio', platform: 'ashby', country: 'switzerland' },
  { slug: 'deepjudge', name: 'DeepJudge', platform: 'ashby', country: 'switzerland' },
  { slug: 'genpeach', name: 'Genpeach', platform: 'ashby', country: 'switzerland' },
  { slug: 'harmattan-ai', name: 'Harmattan AI', platform: 'ashby', country: 'switzerland' },
  { slug: 'jua', name: 'Jua', platform: 'ashby', country: 'switzerland' },
  { slug: 'neuralconcept', name: 'Neural Concept', platform: 'ashby', country: 'switzerland' },
  { slug: 'perk', name: 'Perk', platform: 'ashby', country: 'switzerland' },
  { slug: 'point-one-navigation', name: 'Point One Navigation', platform: 'ashby', country: 'switzerland' },
  { slug: 'proxima-fusion', name: 'Proxima Fusion', platform: 'ashby', country: 'switzerland' },
  { slug: 'salonkee', name: 'Salonkee', platform: 'ashby', country: 'switzerland' },
  { slug: 'skydio', name: 'Skydio', platform: 'ashby', country: 'switzerland' },
  { slug: 'acadiapharmaceuticals', name: 'Acadia Pharmaceuticals Inc.', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'anthropic', name: 'Anthropic', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'bridgebio', name: 'BridgeBio Pharma', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'capco', name: 'Capco', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'cognite', name: 'Cognite - AI for Industry', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'dialecticch', name: 'Dialectic', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'gardacp', name: 'Garda Capital Partners', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'getyourguide', name: 'GetYourGuide', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'icapitalnetwork', name: 'iCapital', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'ionq', name: 'IonQ', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'isomorphiclabs', name: 'Isomorphic Labs', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'kao', name: 'Kao Corporation', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'mirumpharmaceuticals', name: 'Mirum Pharmaceuticals', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'opentable', name: 'OpenTable', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'proalphagroup', name: 'Proalpha Group', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'revolutionmedicines', name: 'Revolution Medicines', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'ripple', name: 'Ripple', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'squarepointcapital', name: 'Squarepoint Capital', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'stepstone', name: 'StepStone Group', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'vaxcyte', name: 'Vaxcyte', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'pia', name: 'WePractice (Psychotherapeut:in in Weiterbildung)', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'pt', name: 'WePractice (Psychotherapeut:in)', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'leit', name: 'WePractice (Psychotherapeutische Leitungsfunktionen)', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'worldquant', name: 'WorldQuant', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'xebiadach', name: 'Xebia DACH', platform: 'greenhouse', country: 'switzerland' },
  { slug: 'anybotics', name: 'ANYbotics', platform: 'lever', country: 'switzerland' },
  { slug: 'celerion', name: 'Celerion', platform: 'lever', country: 'switzerland' },
  { slug: 'everbridge', name: 'Everbridge', platform: 'lever', country: 'switzerland' },
  { slug: 'flux-mobility', name: 'Flux Mobility', platform: 'lever', country: 'switzerland' },
  { slug: 'gravisrobotics', name: 'Gravis Robotics', platform: 'lever', country: 'switzerland' },
  { slug: 'lyrahealth', name: 'Lyra Health', platform: 'lever', country: 'switzerland' },
  { slug: 'rai', name: 'Rai', platform: 'lever', country: 'switzerland' },
  { slug: 'rivr', name: 'RIVR', platform: 'lever', country: 'switzerland' },
  { slug: 'sonarsource', name: 'SonarSource', platform: 'lever', country: 'switzerland' },
  { slug: 'wingtra-2', name: 'Wingtra 2', platform: 'lever', country: 'switzerland' },
  { slug: 'zurichinstruments', name: 'Zurich Instruments', platform: 'lever', country: 'switzerland' },
];

export function feedUrl(company: AtsCompany) {
  switch (company.platform) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs?content=true`;
    case 'lever': return `https://api.lever.co/v0/postings/${company.slug}?mode=json`;
    case 'recruitee': return `https://${company.slug}.recruitee.com/api/offers/`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${company.slug}`;
    case 'personio': return `https://${company.slug}.jobs.personio.de/xml`;
    // Teamtailor documents this feed for syndication: "go to the main jobs page of your careers
    // site and add .rss". The .json form of the same feed is a JSON Feed carrying the whole
    // advertisement in content_html plus an embedded schema.org JobPosting.
    case 'teamtailor': return `https://${company.slug}.teamtailor.com/jobs.json`;
    // Workable's widget endpoint, the one its customers embed in their own careers pages. With
    // details=true it returns the whole advertisement for every posting in a single request, so a
    // board costs one call rather than one per job.
    case 'workable': return `https://apply.workable.com/api/v1/widget/accounts/${company.slug}?details=true`;
  }
}

function decodeEntities(value: string) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function tagText(block: string, tag: string) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
}

/** ISO country codes this app supports, spelled out so the country rule can read them. */
const COUNTRY_NAMES: Record<string, string> = { NL: 'Netherlands', CH: 'Switzerland' };

/**
 * Teamtailor's JSON Feed. Better structured than the other boards: every posting carries the whole
 * advertisement in `content_html` and a schema.org JobPosting whose address has an ISO country
 * code, so the country comes from a field rather than from reading a free-text place name.
 *
 * A posting can list several locations. Each becomes one entry, joined the way a multi-location
 * string arrives from the other boards, so lib/job-identity.ts reads them with the same rule.
 */
function parseTeamtailor(company: AtsCompany, body: string, fallback: string): ParsedJob[] {
  const items = (JSON.parse(body) as { items?: unknown[] }).items ?? [];
  return (items as Array<Record<string, unknown>>).map((item): ParsedJob | null => {
    const posting = (item._jobposting ?? {}) as Record<string, unknown>;
    const raw = posting.jobLocation;
    const places = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<Record<string, unknown>>;
    const location = places
      .map((place) => (place.address ?? {}) as Record<string, string | null>)
      .map((address) => {
        const code = (address.addressCountry ?? '').toUpperCase();
        const country = COUNTRY_NAMES[code] ?? address.addressRegion ?? code;
        return [address.addressLocality?.trim(), country?.trim()].filter(Boolean).join(', ');
      })
      .filter(Boolean)
      .join('; ');
    return {
      sourceUrl: String(item.url ?? ''),
      title: String(item.title ?? posting.title ?? ''),
      company: company.name,
      location: location || fallback,
      descriptionHtml: String(item.content_html ?? posting.description ?? ''),
      postedAt: String(item.date_published ?? posting.datePosted ?? ''),
    };
  }).filter((job): job is ParsedJob => Boolean(job?.sourceUrl && job.title && job.descriptionHtml.trim()));
}

/** Each platform publishes a different shape; normalize them all to ParsedJob. */
export function parseFeed(company: AtsCompany, body: string): ParsedJob[] {
  const fallback = company.country === 'switzerland' ? 'Switzerland' : 'Netherlands';
  if (company.platform === 'personio') {
    return [...body.matchAll(/<position>([\s\S]*?)<\/position>/gi)].map((match) => {
      const block = match[1];
      const id = tagText(block, 'id');
      const descriptions = [...block.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/gi)]
        .map((entry) => `${tagText(entry[1], 'name')} ${tagText(entry[1], 'value')}`).join(' ');
      return {
        sourceUrl: `https://${company.slug}.jobs.personio.de/job/${id}`,
        title: tagText(block, 'name'),
        company: company.name,
        location: tagText(block, 'office') || fallback,
        descriptionHtml: descriptions,
        postedAt: tagText(block, 'createdAt'),
      };
    }).filter((job) => job.title && job.descriptionHtml.trim());
  }

  if (company.platform === 'teamtailor') return parseTeamtailor(company, body, fallback);

  if (company.platform === 'workable') {
    // Country arrives spelled out ("Switzerland", "Netherlands"), so city and country together
    // read the same way as every other board's free-text location.
    const jobs = (JSON.parse(body) as { jobs?: unknown[] }).jobs ?? [];
    return (jobs as Array<Record<string, unknown>>).map((job): ParsedJob => ({
      sourceUrl: String(job.url ?? job.shortlink ?? job.application_url ?? ''),
      title: String(job.title ?? ''),
      company: company.name,
      location: [job.city, job.country].map((part) => String(part ?? '').trim())
        .filter(Boolean).join(', ') || fallback,
      descriptionHtml: String(job.description ?? ''),
      postedAt: String(job.published_on ?? job.created_at ?? ''),
    })).filter((job) => Boolean(job.sourceUrl && job.title && job.descriptionHtml.trim()));
  }

  const payload: unknown = JSON.parse(body);
  const rows = Array.isArray(payload) ? payload
    : (payload as { jobs?: unknown[]; offers?: unknown[] }).jobs
    ?? (payload as { offers?: unknown[] }).offers
    ?? [];

  return (rows as Record<string, never>[]).map((row): ParsedJob | null => {
    const get = (key: string) => (row as Record<string, unknown>)[key];
    if (company.platform === 'greenhouse') {
      const content = String(get('content') ?? '');
      return {
        sourceUrl: String(get('absolute_url') ?? ''),
        title: String(get('title') ?? ''),
        company: company.name,
        location: (get('location') as { name?: string })?.name || fallback,
        descriptionHtml: decodeEntities(content),
        postedAt: String(get('first_published') ?? get('updated_at') ?? ''),
      };
    }
    if (company.platform === 'ashby') {
      return {
        sourceUrl: String(get('jobUrl') ?? ''),
        title: String(get('title') ?? ''),
        company: company.name,
        location: String(get('location') ?? '') || fallback,
        descriptionHtml: String(get('descriptionHtml') ?? get('descriptionPlain') ?? ''),
        postedAt: String(get('publishedAt') ?? ''),
      };
    }
    if (company.platform === 'lever') {
      return {
        sourceUrl: String(get('hostedUrl') ?? ''),
        title: String(get('text') ?? ''),
        company: company.name,
        location: (get('categories') as { location?: string })?.location || fallback,
        descriptionHtml: String(get('description') ?? get('descriptionPlain') ?? ''),
        postedAt: get('createdAt') ? new Date(Number(get('createdAt'))).toISOString() : '',
      };
    }
    // recruitee
    return {
      sourceUrl: String(get('careers_url') ?? get('careers_apply_url') ?? ''),
      title: String(get('title') ?? get('position') ?? ''),
      company: company.name,
      location: [get('city'), get('country')].filter(Boolean).join(', ') || fallback,
      descriptionHtml: `${String(get('description') ?? '')} ${String(get('requirements') ?? '')}`,
      postedAt: String(get('published_at') ?? get('created_at') ?? ''),
    };
  }).filter((job): job is ParsedJob => Boolean(job?.sourceUrl && job.title && job.descriptionHtml.trim()));
}

/**
 * How board fetching is bounded, checked against Cloudflare's published Workers limits
 * (developers.cloudflare.com/workers/platform/limits, read 2026-09-14):
 *
 * - **6 simultaneous connections** per invocation. A seventh is queued rather than failed, so
 *   BOARD_CONCURRENCY matches the platform instead of opening connections that would only wait.
 * - **50 subrequests per invocation on Free, 10,000 on Paid.** A search already contacts more than
 *   50 upstreams before any employer board, so the Free plan cannot run this app whatever this
 *   list holds.
 * - **10 ms CPU on Free, 30 s default on Paid.** Parsing is the CPU cost here, not waiting.
 *
 * **No cap on the number of boards, deliberately, for now.** The app runs only in the local
 * environments, where none of those limits apply, and the owner's decision (2026-09-14) is
 * full coverage first, caps later. A 600-board ceiling added in #55 was removed on that decision.
 * Before any hosted deployment the Paid subrequest budget has to be shared between these boards
 * and every other source in the same search, and a ceiling belongs back here.
 *
 * Neither remaining constant limits coverage. BOARD_CONCURRENCY paces the requests and
 * BOARD_TIMEOUT_MS stops one slow board from holding the whole search open.
 */
export const BOARD_CONCURRENCY = 6;
export const BOARD_TIMEOUT_MS = 8_000;

/** Runs fn over items with at most `limit` in flight, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[], limit: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export type BoardFetchStatus = 'ok' | 'timeout' | 'http-error' | 'network-error' | 'parse-error';

export interface BoardFetchOutcome {
  company: AtsCompany;
  status: BoardFetchStatus;
  /** Present when the board answered with a non-2xx status. */
  httpStatus?: number;
  /** Postings read from this board; empty unless status is 'ok'. */
  jobs: ParsedJob[];
  durationMs: number;
  /** Safe, non-sensitive reason for non-ok outcomes (no credentials or tokens). */
  error?: string;
}

/**
 * Whether a refused board must be left alone rather than retried. A 429, 403, 404 or other
 * client refusal is a stop signal from the other side; pushing through it with retries is
 * hammering a source that told us to stop. Only timeouts, network failures and 5xx responses
 * may be retried, and then at most once.
 */
export function isBoardRefusal(outcome: Pick<BoardFetchOutcome, 'status' | 'httpStatus'>) {
  if (outcome.status !== 'http-error' || outcome.httpStatus === undefined) return false;
  // A 429 is a 4xx like any other refusal; it needs no special case beside the range.
  return outcome.httpStatus >= 400 && outcome.httpStatus < 500;
}

export function isBoardRetryable(outcome: Pick<BoardFetchOutcome, 'status' | 'httpStatus'>) {
  if (outcome.status === 'timeout' || outcome.status === 'network-error') return true;
  if (outcome.status === 'http-error' && outcome.httpStatus !== undefined) {
    return outcome.httpStatus >= 500 && outcome.httpStatus < 600;
  }
  return false;
}

function isTimeoutError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Reads one board, classifying the outcome instead of collapsing every failure to an empty
 * list. A board with no jobs and a board that timed out used to look identical, which hid the
 * successive-fetch decline in #75. Resolves in every case — one unreachable, slow or reshaped
 * board must never fail the whole source.
 */
export async function fetchCompany(company: AtsCompany, timeoutMs = BOARD_TIMEOUT_MS): Promise<BoardFetchOutcome> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const done = (outcome: Omit<BoardFetchOutcome, 'company' | 'durationMs'>): BoardFetchOutcome =>
    ({ company, durationMs: Date.now() - started, ...outcome });
  try {
    let response: Response;
    try {
      response = await fetch(feedUrl(company), {
        headers: { accept: 'application/json, application/xml' },
        signal: controller.signal,
      });
    } catch (error) {
      if (isTimeoutError(error) || controller.signal.aborted) {
        return done({ status: 'timeout', jobs: [], error: `timed out after ${timeoutMs}ms` });
      }
      return done({ status: 'network-error', jobs: [], error: error instanceof Error ? error.message.slice(0, 160) : 'network request failed' });
    }
    if (!response.ok) {
      return done({ status: 'http-error', httpStatus: response.status, jobs: [], error: `HTTP ${response.status}` });
    }
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      if (isTimeoutError(error) || controller.signal.aborted) {
        return done({ status: 'timeout', jobs: [], error: `timed out after ${timeoutMs}ms` });
      }
      return done({ status: 'network-error', jobs: [], error: error instanceof Error ? error.message.slice(0, 160) : 'body read failed' });
    }
    try {
      return done({ status: 'ok', jobs: parseFeed(company, body) });
    } catch (error) {
      return done({ status: 'parse-error', jobs: [], error: error instanceof Error ? error.message.slice(0, 160) : 'response could not be parsed' });
    }
  } finally {
    clearTimeout(timer);
  }
}

let cached: { at: number; jobs: ParsedJob[] } | undefined;
const CACHE_MS = 60_000;

/**
 * Reads every configured board once, keeping the per-board outcome so callers can tell a
 * board with no jobs apart from a board that failed. Used by the measurement script and by
 * searchAtsBoards below; boards are independent, so a failure stays isolated to one company.
 *
 * A board that fails transiently — timeout, network failure, or a 5xx response — is retried
 * exactly once after a short pause. Measured for #75: without a retry, 1–2 of the 282 boards
 * timed out per pass (a different board each time, so the loss moved around and totals
 * wobbled); with one retry, 6 consecutive passes returned 281/282 boards and an identical
 * 30,057 postings every time, with zero 429s across ~1,700 fetches. The retry is what recovers
 * the transient loss, and the measurement is why there is exactly one of it: refusals
 * (429/4xx) are never retried, and no pacing was added because no rate limiting was observed.
 */
const BOARD_RETRY_DELAY_MS = 1_000;

async function fetchCompanyWithRetry(company: AtsCompany): Promise<BoardFetchOutcome> {
  const first = await fetchCompany(company);
  if (first.status === 'ok' || isBoardRefusal(first) || !isBoardRetryable(first)) return first;
  await new Promise((resolve) => setTimeout(resolve, BOARD_RETRY_DELAY_MS));
  return fetchCompany(company);
}

export async function searchAtsBoardsDetailed(): Promise<BoardFetchOutcome[]> {
  return mapWithConcurrency(atsCompanies, BOARD_CONCURRENCY, (company) => fetchCompanyWithRetry(company));
}

/**
 * Reads every configured board once and serves both country adapters from that result, so an
 * international company contributes its Swiss and its Dutch roles rather than only its home
 * market. Boards are independent, so a failure is isolated to one company. The scrape route
 * assigns each posting a country from its own location, which is what filters this list.
 */
export async function searchAtsBoards(): Promise<ParsedJob[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.jobs;
  const outcomes = await searchAtsBoardsDetailed();
  const byUrl = new Map<string, ParsedJob>();
  for (const outcome of outcomes) for (const job of outcome.jobs) if (!byUrl.has(job.sourceUrl)) byUrl.set(job.sourceUrl, job);
  const jobs = [...byUrl.values()];
  cached = { at: Date.now(), jobs };
  return jobs;
}
