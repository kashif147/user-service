/**
 * Country Data Seeding Script
 *
 * Seeds the database with comprehensive country data including
 * ISO2 codes, ISO3 codes, display names, and calling codes
 */

const mongoose = require("mongoose");
const Country = require("../models/country.model");

// Comprehensive country data with ISO2, ISO3, display names, and calling codes
const countriesData = [
  { code: "AD", name: "AND", displayname: "Andorra", callingCodes: ["+376"] },
  {
    code: "AE",
    name: "ARE",
    displayname: "United Arab Emirates",
    callingCodes: ["+971"],
  },
  {
    code: "AF",
    name: "AFG",
    displayname: "Afghanistan",
    callingCodes: ["+93"],
  },
  {
    code: "AG",
    name: "ATG",
    displayname: "Antigua and Barbuda",
    callingCodes: ["+1-268"],
  },
  {
    code: "AI",
    name: "AIA",
    displayname: "Anguilla",
    callingCodes: ["+1-264"],
  },
  { code: "AL", name: "ALB", displayname: "Albania", callingCodes: ["+355"] },
  { code: "AM", name: "ARM", displayname: "Armenia", callingCodes: ["+374"] },
  { code: "AO", name: "AGO", displayname: "Angola", callingCodes: ["+244"] },
  { code: "AQ", name: "ATA", displayname: "Antarctica", callingCodes: [] },
  { code: "AR", name: "ARG", displayname: "Argentina", callingCodes: ["+54"] },
  {
    code: "AS",
    name: "ASM",
    displayname: "American Samoa",
    callingCodes: ["+1-684"],
  },
  { code: "AT", name: "AUT", displayname: "Austria", callingCodes: ["+43"] },
  { code: "AU", name: "AUS", displayname: "Australia", callingCodes: ["+61"] },
  { code: "AW", name: "ABW", displayname: "Aruba", callingCodes: ["+297"] },
  {
    code: "AX",
    name: "ALA",
    displayname: "Åland Islands",
    callingCodes: ["+358"],
  },
  {
    code: "AZ",
    name: "AZE",
    displayname: "Azerbaijan",
    callingCodes: ["+994"],
  },
  {
    code: "BA",
    name: "BIH",
    displayname: "Bosnia and Herzegovina",
    callingCodes: ["+387"],
  },
  {
    code: "BB",
    name: "BRB",
    displayname: "Barbados",
    callingCodes: ["+1-246"],
  },
  {
    code: "BD",
    name: "BGD",
    displayname: "Bangladesh",
    callingCodes: ["+880"],
  },
  { code: "BE", name: "BEL", displayname: "Belgium", callingCodes: ["+32"] },
  {
    code: "BF",
    name: "BFA",
    displayname: "Burkina Faso",
    callingCodes: ["+226"],
  },
  { code: "BG", name: "BGR", displayname: "Bulgaria", callingCodes: ["+359"] },
  { code: "BH", name: "BHR", displayname: "Bahrain", callingCodes: ["+973"] },
  { code: "BI", name: "BDI", displayname: "Burundi", callingCodes: ["+257"] },
  { code: "BJ", name: "BEN", displayname: "Benin", callingCodes: ["+229"] },
  {
    code: "BL",
    name: "BLM",
    displayname: "Saint Barthélemy",
    callingCodes: ["+590"],
  },
  { code: "BM", name: "BMU", displayname: "Bermuda", callingCodes: ["+1-441"] },
  { code: "BN", name: "BRN", displayname: "Brunei", callingCodes: ["+673"] },
  { code: "BO", name: "BOL", displayname: "Bolivia", callingCodes: ["+591"] },
  {
    code: "BQ",
    name: "BES",
    displayname: "Caribbean Netherlands",
    callingCodes: ["+599"],
  },
  { code: "BR", name: "BRA", displayname: "Brazil", callingCodes: ["+55"] },
  { code: "BS", name: "BHS", displayname: "Bahamas", callingCodes: ["+1-242"] },
  { code: "BT", name: "BTN", displayname: "Bhutan", callingCodes: ["+975"] },
  { code: "BV", name: "BVT", displayname: "Bouvet Island", callingCodes: [] },
  { code: "BW", name: "BWA", displayname: "Botswana", callingCodes: ["+267"] },
  { code: "BY", name: "BLR", displayname: "Belarus", callingCodes: ["+375"] },
  { code: "BZ", name: "BLZ", displayname: "Belize", callingCodes: ["+501"] },
  { code: "CA", name: "CAN", displayname: "Canada", callingCodes: ["+1"] },
  {
    code: "CC",
    name: "CCK",
    displayname: "Cocos Islands",
    callingCodes: ["+61"],
  },
  {
    code: "CD",
    name: "COD",
    displayname: "Democratic Republic of the Congo",
    callingCodes: ["+243"],
  },
  {
    code: "CF",
    name: "CAF",
    displayname: "Central African Republic",
    callingCodes: ["+236"],
  },
  {
    code: "CG",
    name: "COG",
    displayname: "Republic of the Congo",
    callingCodes: ["+242"],
  },
  {
    code: "CH",
    name: "CHE",
    displayname: "Switzerland",
    callingCodes: ["+41"],
  },
  {
    code: "CI",
    name: "CIV",
    displayname: "Côte d'Ivoire",
    callingCodes: ["+225"],
  },
  {
    code: "CK",
    name: "COK",
    displayname: "Cook Islands",
    callingCodes: ["+682"],
  },
  { code: "CL", name: "CHL", displayname: "Chile", callingCodes: ["+56"] },
  { code: "CM", name: "CMR", displayname: "Cameroon", callingCodes: ["+237"] },
  { code: "CN", name: "CHN", displayname: "China", callingCodes: ["+86"] },
  { code: "CO", name: "COL", displayname: "Colombia", callingCodes: ["+57"] },
  {
    code: "CR",
    name: "CRI",
    displayname: "Costa Rica",
    callingCodes: ["+506"],
  },
  { code: "CU", name: "CUB", displayname: "Cuba", callingCodes: ["+53"] },
  {
    code: "CV",
    name: "CPV",
    displayname: "Cape Verde",
    callingCodes: ["+238"],
  },
  { code: "CW", name: "CUW", displayname: "Curaçao", callingCodes: ["+599"] },
  {
    code: "CX",
    name: "CXR",
    displayname: "Christmas Island",
    callingCodes: ["+61"],
  },
  { code: "CY", name: "CYP", displayname: "Cyprus", callingCodes: ["+357"] },
  {
    code: "CZ",
    name: "CZE",
    displayname: "Czech Republic",
    callingCodes: ["+420"],
  },
  { code: "DE", name: "DEU", displayname: "Germany", callingCodes: ["+49"] },
  { code: "DJ", name: "DJI", displayname: "Djibouti", callingCodes: ["+253"] },
  { code: "DK", name: "DNK", displayname: "Denmark", callingCodes: ["+45"] },
  {
    code: "DM",
    name: "DMA",
    displayname: "Dominica",
    callingCodes: ["+1-767"],
  },
  {
    code: "DO",
    name: "DOM",
    displayname: "Dominican Republic",
    callingCodes: ["+1-809", "+1-829", "+1-849"],
  },
  { code: "DZ", name: "DZA", displayname: "Algeria", callingCodes: ["+213"] },
  { code: "EC", name: "ECU", displayname: "Ecuador", callingCodes: ["+593"] },
  { code: "EE", name: "EST", displayname: "Estonia", callingCodes: ["+372"] },
  { code: "EG", name: "EGY", displayname: "Egypt", callingCodes: ["+20"] },
  {
    code: "EH",
    name: "ESH",
    displayname: "Western Sahara",
    callingCodes: ["+212"],
  },
  { code: "ER", name: "ERI", displayname: "Eritrea", callingCodes: ["+291"] },
  { code: "ES", name: "ESP", displayname: "Spain", callingCodes: ["+34"] },
  { code: "ET", name: "ETH", displayname: "Ethiopia", callingCodes: ["+251"] },
  { code: "FI", name: "FIN", displayname: "Finland", callingCodes: ["+358"] },
  { code: "FJ", name: "FJI", displayname: "Fiji", callingCodes: ["+679"] },
  {
    code: "FK",
    name: "FLK",
    displayname: "Falkland Islands",
    callingCodes: ["+500"],
  },
  {
    code: "FM",
    name: "FSM",
    displayname: "Micronesia",
    callingCodes: ["+691"],
  },
  {
    code: "FO",
    name: "FRO",
    displayname: "Faroe Islands",
    callingCodes: ["+298"],
  },
  { code: "FR", name: "FRA", displayname: "France", callingCodes: ["+33"] },
  { code: "GA", name: "GAB", displayname: "Gabon", callingCodes: ["+241"] },
  {
    code: "GB",
    name: "GBR",
    displayname: "United Kingdom",
    callingCodes: ["+44"],
  },
  { code: "GD", name: "GRD", displayname: "Grenada", callingCodes: ["+1-473"] },
  { code: "GE", name: "GEO", displayname: "Georgia", callingCodes: ["+995"] },
  {
    code: "GF",
    name: "GUF",
    displayname: "French Guiana",
    callingCodes: ["+594"],
  },
  { code: "GG", name: "GGY", displayname: "Guernsey", callingCodes: ["+44"] },
  { code: "GH", name: "GHA", displayname: "Ghana", callingCodes: ["+233"] },
  { code: "GI", name: "GIB", displayname: "Gibraltar", callingCodes: ["+350"] },
  { code: "GL", name: "GRL", displayname: "Greenland", callingCodes: ["+299"] },
  { code: "GM", name: "GMB", displayname: "Gambia", callingCodes: ["+220"] },
  { code: "GN", name: "GIN", displayname: "Guinea", callingCodes: ["+224"] },
  {
    code: "GP",
    name: "GLP",
    displayname: "Guadeloupe",
    callingCodes: ["+590"],
  },
  {
    code: "GQ",
    name: "GNQ",
    displayname: "Equatorial Guinea",
    callingCodes: ["+240"],
  },
  { code: "GR", name: "GRC", displayname: "Greece", callingCodes: ["+30"] },
  {
    code: "GS",
    name: "SGS",
    displayname: "South Georgia and the South Sandwich Islands",
    callingCodes: ["+500"],
  },
  { code: "GT", name: "GTM", displayname: "Guatemala", callingCodes: ["+502"] },
  { code: "GU", name: "GUM", displayname: "Guam", callingCodes: ["+1-671"] },
  {
    code: "GW",
    name: "GNB",
    displayname: "Guinea-Bissau",
    callingCodes: ["+245"],
  },
  { code: "GY", name: "GUY", displayname: "Guyana", callingCodes: ["+592"] },
  { code: "HK", name: "HKG", displayname: "Hong Kong", callingCodes: ["+852"] },
  {
    code: "HM",
    name: "HMD",
    displayname: "Heard Island and McDonald Islands",
    callingCodes: [],
  },
  { code: "HN", name: "HND", displayname: "Honduras", callingCodes: ["+504"] },
  { code: "HR", name: "HRV", displayname: "Croatia", callingCodes: ["+385"] },
  { code: "HT", name: "HTI", displayname: "Haiti", callingCodes: ["+509"] },
  { code: "HU", name: "HUN", displayname: "Hungary", callingCodes: ["+36"] },
  { code: "ID", name: "IDN", displayname: "Indonesia", callingCodes: ["+62"] },
  { code: "IE", name: "IRL", displayname: "Ireland", callingCodes: ["+353"] },
  { code: "IL", name: "ISR", displayname: "Israel", callingCodes: ["+972"] },
  {
    code: "IM",
    name: "IMN",
    displayname: "Isle of Man",
    callingCodes: ["+44"],
  },
  { code: "IN", name: "IND", displayname: "India", callingCodes: ["+91"] },
  {
    code: "IO",
    name: "IOT",
    displayname: "British Indian Ocean Territory",
    callingCodes: ["+246"],
  },
  { code: "IQ", name: "IRQ", displayname: "Iraq", callingCodes: ["+964"] },
  { code: "IR", name: "IRN", displayname: "Iran", callingCodes: ["+98"] },
  { code: "IS", name: "ISL", displayname: "Iceland", callingCodes: ["+354"] },
  { code: "IT", name: "ITA", displayname: "Italy", callingCodes: ["+39"] },
  { code: "JE", name: "JEY", displayname: "Jersey", callingCodes: ["+44"] },
  { code: "JM", name: "JAM", displayname: "Jamaica", callingCodes: ["+1-876"] },
  { code: "JO", name: "JOR", displayname: "Jordan", callingCodes: ["+962"] },
  { code: "JP", name: "JPN", displayname: "Japan", callingCodes: ["+81"] },
  { code: "KE", name: "KEN", displayname: "Kenya", callingCodes: ["+254"] },
  {
    code: "KG",
    name: "KGZ",
    displayname: "Kyrgyzstan",
    callingCodes: ["+996"],
  },
  { code: "KH", name: "KHM", displayname: "Cambodia", callingCodes: ["+855"] },
  { code: "KI", name: "KIR", displayname: "Kiribati", callingCodes: ["+686"] },
  { code: "KM", name: "COM", displayname: "Comoros", callingCodes: ["+269"] },
  {
    code: "KN",
    name: "KNA",
    displayname: "Saint Kitts and Nevis",
    callingCodes: ["+1-869"],
  },
  {
    code: "KP",
    name: "PRK",
    displayname: "North Korea",
    callingCodes: ["+850"],
  },
  {
    code: "KR",
    name: "KOR",
    displayname: "South Korea",
    callingCodes: ["+82"],
  },
  { code: "KW", name: "KWT", displayname: "Kuwait", callingCodes: ["+965"] },
  {
    code: "KY",
    name: "CYM",
    displayname: "Cayman Islands",
    callingCodes: ["+1-345"],
  },
  { code: "KZ", name: "KAZ", displayname: "Kazakhstan", callingCodes: ["+7"] },
  { code: "LA", name: "LAO", displayname: "Laos", callingCodes: ["+856"] },
  { code: "LB", name: "LBN", displayname: "Lebanon", callingCodes: ["+961"] },
  {
    code: "LC",
    name: "LCA",
    displayname: "Saint Lucia",
    callingCodes: ["+1-758"],
  },
  {
    code: "LI",
    name: "LIE",
    displayname: "Liechtenstein",
    callingCodes: ["+423"],
  },
  { code: "LK", name: "LKA", displayname: "Sri Lanka", callingCodes: ["+94"] },
  { code: "LR", name: "LBR", displayname: "Liberia", callingCodes: ["+231"] },
  { code: "LS", name: "LSO", displayname: "Lesotho", callingCodes: ["+266"] },
  { code: "LT", name: "LTU", displayname: "Lithuania", callingCodes: ["+370"] },
  {
    code: "LU",
    name: "LUX",
    displayname: "Luxembourg",
    callingCodes: ["+352"],
  },
  { code: "LV", name: "LVA", displayname: "Latvia", callingCodes: ["+371"] },
  { code: "LY", name: "LBY", displayname: "Libya", callingCodes: ["+218"] },
  { code: "MA", name: "MAR", displayname: "Morocco", callingCodes: ["+212"] },
  { code: "MC", name: "MCO", displayname: "Monaco", callingCodes: ["+377"] },
  { code: "MD", name: "MDA", displayname: "Moldova", callingCodes: ["+373"] },
  {
    code: "ME",
    name: "MNE",
    displayname: "Montenegro",
    callingCodes: ["+382"],
  },
  {
    code: "MF",
    name: "MAF",
    displayname: "Saint Martin",
    callingCodes: ["+590"],
  },
  {
    code: "MG",
    name: "MDG",
    displayname: "Madagascar",
    callingCodes: ["+261"],
  },
  {
    code: "MH",
    name: "MHL",
    displayname: "Marshall Islands",
    callingCodes: ["+692"],
  },
  {
    code: "MK",
    name: "MKD",
    displayname: "North Macedonia",
    callingCodes: ["+389"],
  },
  { code: "ML", name: "MLI", displayname: "Mali", callingCodes: ["+223"] },
  { code: "MM", name: "MMR", displayname: "Myanmar", callingCodes: ["+95"] },
  { code: "MN", name: "MNG", displayname: "Mongolia", callingCodes: ["+976"] },
  { code: "MO", name: "MAC", displayname: "Macao", callingCodes: ["+853"] },
  {
    code: "MP",
    name: "MNP",
    displayname: "Northern Mariana Islands",
    callingCodes: ["+1-670"],
  },
  {
    code: "MQ",
    name: "MTQ",
    displayname: "Martinique",
    callingCodes: ["+596"],
  },
  {
    code: "MR",
    name: "MRT",
    displayname: "Mauritania",
    callingCodes: ["+222"],
  },
  {
    code: "MS",
    name: "MSR",
    displayname: "Montserrat",
    callingCodes: ["+1-664"],
  },
  { code: "MT", name: "MLT", displayname: "Malta", callingCodes: ["+356"] },
  { code: "MU", name: "MUS", displayname: "Mauritius", callingCodes: ["+230"] },
  { code: "MV", name: "MDV", displayname: "Maldives", callingCodes: ["+960"] },
  { code: "MW", name: "MWI", displayname: "Malawi", callingCodes: ["+265"] },
  { code: "MX", name: "MEX", displayname: "Mexico", callingCodes: ["+52"] },
  { code: "MY", name: "MYS", displayname: "Malaysia", callingCodes: ["+60"] },
  {
    code: "MZ",
    name: "MOZ",
    displayname: "Mozambique",
    callingCodes: ["+258"],
  },
  { code: "NA", name: "NAM", displayname: "Namibia", callingCodes: ["+264"] },
  {
    code: "NC",
    name: "NCL",
    displayname: "New Caledonia",
    callingCodes: ["+687"],
  },
  { code: "NE", name: "NER", displayname: "Niger", callingCodes: ["+227"] },
  {
    code: "NF",
    name: "NFK",
    displayname: "Norfolk Island",
    callingCodes: ["+672"],
  },
  { code: "NG", name: "NGA", displayname: "Nigeria", callingCodes: ["+234"] },
  { code: "NI", name: "NIC", displayname: "Nicaragua", callingCodes: ["+505"] },
  {
    code: "NL",
    name: "NLD",
    displayname: "Netherlands",
    callingCodes: ["+31"],
  },
  { code: "NO", name: "NOR", displayname: "Norway", callingCodes: ["+47"] },
  { code: "NP", name: "NPL", displayname: "Nepal", callingCodes: ["+977"] },
  { code: "NR", name: "NRU", displayname: "Nauru", callingCodes: ["+674"] },
  { code: "NU", name: "NIU", displayname: "Niue", callingCodes: ["+683"] },
  {
    code: "NZ",
    name: "NZL",
    displayname: "New Zealand",
    callingCodes: ["+64"],
  },
  { code: "OM", name: "OMN", displayname: "Oman", callingCodes: ["+968"] },
  { code: "PA", name: "PAN", displayname: "Panama", callingCodes: ["+507"] },
  { code: "PE", name: "PER", displayname: "Peru", callingCodes: ["+51"] },
  {
    code: "PF",
    name: "PYF",
    displayname: "French Polynesia",
    callingCodes: ["+689"],
  },
  {
    code: "PG",
    name: "PNG",
    displayname: "Papua New Guinea",
    callingCodes: ["+675"],
  },
  {
    code: "PH",
    name: "PHL",
    displayname: "Philippines",
    callingCodes: ["+63"],
  },
  { code: "PK", name: "PAK", displayname: "Pakistan", callingCodes: ["+92"] },
  { code: "PL", name: "POL", displayname: "Poland", callingCodes: ["+48"] },
  {
    code: "PM",
    name: "SPM",
    displayname: "Saint Pierre and Miquelon",
    callingCodes: ["+508"],
  },
  {
    code: "PN",
    name: "PCN",
    displayname: "Pitcairn Islands",
    callingCodes: ["+64"],
  },
  {
    code: "PR",
    name: "PRI",
    displayname: "Puerto Rico",
    callingCodes: ["+1-787", "+1-939"],
  },
  { code: "PS", name: "PSE", displayname: "Palestine", callingCodes: ["+970"] },
  { code: "PT", name: "PRT", displayname: "Portugal", callingCodes: ["+351"] },
  { code: "PW", name: "PLW", displayname: "Palau", callingCodes: ["+680"] },
  { code: "PY", name: "PRY", displayname: "Paraguay", callingCodes: ["+595"] },
  { code: "QA", name: "QAT", displayname: "Qatar", callingCodes: ["+974"] },
  { code: "RE", name: "REU", displayname: "Réunion", callingCodes: ["+262"] },
  { code: "RO", name: "ROU", displayname: "Romania", callingCodes: ["+40"] },
  { code: "RS", name: "SRB", displayname: "Serbia", callingCodes: ["+381"] },
  { code: "RU", name: "RUS", displayname: "Russia", callingCodes: ["+7"] },
  { code: "RW", name: "RWA", displayname: "Rwanda", callingCodes: ["+250"] },
  {
    code: "SA",
    name: "SAU",
    displayname: "Saudi Arabia",
    callingCodes: ["+966"],
  },
  {
    code: "SB",
    name: "SLB",
    displayname: "Solomon Islands",
    callingCodes: ["+677"],
  },
  {
    code: "SC",
    name: "SYC",
    displayname: "Seychelles",
    callingCodes: ["+248"],
  },
  { code: "SD", name: "SDN", displayname: "Sudan", callingCodes: ["+249"] },
  { code: "SE", name: "SWE", displayname: "Sweden", callingCodes: ["+46"] },
  { code: "SG", name: "SGP", displayname: "Singapore", callingCodes: ["+65"] },
  {
    code: "SH",
    name: "SHN",
    displayname: "Saint Helena",
    callingCodes: ["+290"],
  },
  { code: "SI", name: "SVN", displayname: "Slovenia", callingCodes: ["+386"] },
  {
    code: "SJ",
    name: "SJM",
    displayname: "Svalbard and Jan Mayen",
    callingCodes: ["+47"],
  },
  { code: "SK", name: "SVK", displayname: "Slovakia", callingCodes: ["+421"] },
  {
    code: "SL",
    name: "SLE",
    displayname: "Sierra Leone",
    callingCodes: ["+232"],
  },
  {
    code: "SM",
    name: "SMR",
    displayname: "San Marino",
    callingCodes: ["+378"],
  },
  { code: "SN", name: "SEN", displayname: "Senegal", callingCodes: ["+221"] },
  { code: "SO", name: "SOM", displayname: "Somalia", callingCodes: ["+252"] },
  { code: "SR", name: "SUR", displayname: "Suriname", callingCodes: ["+597"] },
  {
    code: "SS",
    name: "SSD",
    displayname: "South Sudan",
    callingCodes: ["+211"],
  },
  {
    code: "ST",
    name: "STP",
    displayname: "São Tomé and Príncipe",
    callingCodes: ["+239"],
  },
  {
    code: "SV",
    name: "SLV",
    displayname: "El Salvador",
    callingCodes: ["+503"],
  },
  {
    code: "SX",
    name: "SXM",
    displayname: "Sint Maarten",
    callingCodes: ["+1-721"],
  },
  { code: "SY", name: "SYR", displayname: "Syria", callingCodes: ["+963"] },
  { code: "SZ", name: "SWZ", displayname: "Eswatini", callingCodes: ["+268"] },
  {
    code: "TC",
    name: "TCA",
    displayname: "Turks and Caicos Islands",
    callingCodes: ["+1-649"],
  },
  { code: "TD", name: "TCD", displayname: "Chad", callingCodes: ["+235"] },
  {
    code: "TF",
    name: "ATF",
    displayname: "French Southern Territories",
    callingCodes: [],
  },
  { code: "TG", name: "TGO", displayname: "Togo", callingCodes: ["+228"] },
  { code: "TH", name: "THA", displayname: "Thailand", callingCodes: ["+66"] },
  {
    code: "TJ",
    name: "TJK",
    displayname: "Tajikistan",
    callingCodes: ["+992"],
  },
  { code: "TK", name: "TKL", displayname: "Tokelau", callingCodes: ["+690"] },
  {
    code: "TL",
    name: "TLS",
    displayname: "Timor-Leste",
    callingCodes: ["+670"],
  },
  {
    code: "TM",
    name: "TKM",
    displayname: "Turkmenistan",
    callingCodes: ["+993"],
  },
  { code: "TN", name: "TUN", displayname: "Tunisia", callingCodes: ["+216"] },
  { code: "TO", name: "TON", displayname: "Tonga", callingCodes: ["+676"] },
  { code: "TR", name: "TUR", displayname: "Turkey", callingCodes: ["+90"] },
  {
    code: "TT",
    name: "TTO",
    displayname: "Trinidad and Tobago",
    callingCodes: ["+1-868"],
  },
  { code: "TV", name: "TUV", displayname: "Tuvalu", callingCodes: ["+688"] },
  { code: "TW", name: "TWN", displayname: "Taiwan", callingCodes: ["+886"] },
  { code: "TZ", name: "TZA", displayname: "Tanzania", callingCodes: ["+255"] },
  { code: "UA", name: "UKR", displayname: "Ukraine", callingCodes: ["+380"] },
  { code: "UG", name: "UGA", displayname: "Uganda", callingCodes: ["+256"] },
  {
    code: "UM",
    name: "UMI",
    displayname: "United States Minor Outlying Islands",
    callingCodes: [],
  },
  {
    code: "US",
    name: "USA",
    displayname: "United States",
    callingCodes: ["+1"],
  },
  { code: "UY", name: "URY", displayname: "Uruguay", callingCodes: ["+598"] },
  {
    code: "UZ",
    name: "UZB",
    displayname: "Uzbekistan",
    callingCodes: ["+998"],
  },
  {
    code: "VA",
    name: "VAT",
    displayname: "Vatican City",
    callingCodes: ["+379"],
  },
  {
    code: "VC",
    name: "VCT",
    displayname: "Saint Vincent and the Grenadines",
    callingCodes: ["+1-784"],
  },
  { code: "VE", name: "VEN", displayname: "Venezuela", callingCodes: ["+58"] },
  {
    code: "VG",
    name: "VGB",
    displayname: "British Virgin Islands",
    callingCodes: ["+1-284"],
  },
  {
    code: "VI",
    name: "VIR",
    displayname: "U.S. Virgin Islands",
    callingCodes: ["+1-340"],
  },
  { code: "VN", name: "VNM", displayname: "Vietnam", callingCodes: ["+84"] },
  { code: "VU", name: "VUT", displayname: "Vanuatu", callingCodes: ["+678"] },
  {
    code: "WF",
    name: "WLF",
    displayname: "Wallis and Futuna",
    callingCodes: ["+681"],
  },
  { code: "WS", name: "WSM", displayname: "Samoa", callingCodes: ["+685"] },
  { code: "YE", name: "YEM", displayname: "Yemen", callingCodes: ["+967"] },
  { code: "YT", name: "MYT", displayname: "Mayotte", callingCodes: ["+262"] },
  {
    code: "ZA",
    name: "ZAF",
    displayname: "South Africa",
    callingCodes: ["+27"],
  },
  { code: "ZM", name: "ZMB", displayname: "Zambia", callingCodes: ["+260"] },
  { code: "ZW", name: "ZWE", displayname: "Zimbabwe", callingCodes: ["+263"] },
];

/**
 * Connect to MongoDB
 */
async function connectToDatabase() {
  try {
    // Load environment variables based on NODE_ENV
    if (process.env.NODE_ENV === "staging") {
      require("dotenv").config({ path: ".env.staging" });
    } else if (process.env.NODE_ENV === "development") {
      require("dotenv").config({ path: ".env.development" });
    } else {
      require("dotenv").config();
    }

    const mongoUri =
      process.env.MONGO_URI || "mongodb://localhost:27017/user-service-db";

    console.log(
      `🔗 Connecting to ${process.env.NODE_ENV || "default"} environment...`
    );
    console.log(`📊 Database: ${mongoUri.split("/").pop().split("?")[0]}`);

    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  }
}

/**
 * Clear existing countries data
 */
async function clearExistingData() {
  try {
    const result = await Country.deleteMany({});
    console.log(`🗑️ Cleared ${result.deletedCount} existing countries`);
  } catch (error) {
    console.error("❌ Error clearing existing data:", error);
    throw error;
  }
}

/**
 * Seed countries data
 */
async function seedCountries() {
  try {
    console.log("🌍 Starting countries seeding...");

    // Add userid to each country (using a default admin user ID)
    const defaultUserId =
      process.env.DEFAULT_USER_ID || "507f1f77bcf86cd799439011";

    const countriesWithUserId = countriesData.map((country) => ({
      ...country,
      userid: defaultUserId,
      isactive: true,
      isdeleted: false,
    }));

    const result = await Country.insertMany(countriesWithUserId);
    console.log(`✅ Successfully seeded ${result.length} countries`);

    return result;
  } catch (error) {
    console.error("❌ Error seeding countries:", error);
    throw error;
  }
}

/**
 * Verify seeded data
 */
async function verifySeededData() {
  try {
    const count = await Country.countDocuments({ isdeleted: false });
    console.log(`📊 Total active countries in database: ${count}`);

    // Show some sample countries
    const sampleCountries = await Country.find({ isdeleted: false })
      .select("code name displayname callingCodes")
      .limit(5)
      .sort({ displayname: 1 });

    console.log("📋 Sample countries:");
    sampleCountries.forEach((country) => {
      console.log(
        `  ${country.code} (${country.name}) - ${
          country.displayname
        } - ${country.callingCodes.join(", ")}`
      );
    });
  } catch (error) {
    console.error("❌ Error verifying data:", error);
    throw error;
  }
}

/**
 * Main seeding function
 */
async function main() {
  try {
    console.log("🚀 Starting Country Data Seeding Process");
    console.log("==========================================");

    await connectToDatabase();
    await clearExistingData();
    await seedCountries();
    await verifySeededData();

    console.log("==========================================");
    console.log("✅ Country seeding completed successfully!");
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

// Run the seeding process
if (require.main === module) {
  main();
}

module.exports = {
  countriesData,
  seedCountries,
  clearExistingData,
  verifySeededData,
};
