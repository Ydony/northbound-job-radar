/**
 * Recorded FreeHire API responses (INT-07, #166).
 *
 * Captured 2026-09-24 with bounded unauthenticated reads against the
 * documented public full-description endpoint
 * (GET /api/v1/agent/jobs/search?countries=CH|NL&posting_language=en&limit=5).
 * Verbatim apart from pretty-printing: the shape these tests assert against is
 * the shape the service actually returns. Tests run against these records, never live.
 */
import type { FreehireJob } from '../../lib/freehire';

/** Eligible upstream (greenhouse), Switzerland, English-tagged. */
export const recordedEligibleCh: FreehireJob = {
  "public_slug": "account-executive-commvault-yumjjeqf",
  "source": "greenhouse",
  "manually_added": false,
  "external_id": "commvault:5321610008",
  "url": "https://job-boards.greenhouse.io/commvault/jobs/5321610008?utm_source=freehire.me",
  "title": "Account Executive",
  "company": "Commvault",
  "company_slug": "commvault",
  "location": "Wallisellen, Switzerland",
  "description": "<div><p><strong>Recruitment Fraud Alert</strong></p>\n<p>We’ve learned that scammers are impersonating Commvault team members—including HR and leadership—via email or text. These bad actors may conduct fake interviews and ask for personal information, such as your social security number.  </p>\n<p><strong>What to know:</strong></p>\n<ul>\n<li>Commvault does <em>not</em> conduct interviews by email or text.</li>\n<li>We will never ask you to submit sensitive documents (including banking information, SSN, etc) before your first day.</li>\n<li>Commvault recruiters may contact prospective candidates through LinkedIn and other professional networking platforms regarding career opportunities. If you are unsure whether a recruiting communication is legitimate, review the profile to ensure they have a badge verifying them as a Commvault employee.</li>\n</ul>\n<p>If you suspect a recruiting scam, please contact us at <u>wwrecruitingteam@commvault.com </u></p>\n<p> </p>\n<p><strong>About Commvault</strong> </p>\n<p>Commvault (NASDAQ: CVLT) is the gold standard in cyber resilience. The company empowers customers to uncover, take action, and rapidly recover from cyberattacks – keeping data safe and businesses resilient. The company’s unique AI-powered platform combines best-in-class data protection, exceptional data security, advanced data intelligence, and lightning-fast recovery across any workload or cloud at the lowest TCO. For over 25 years, more than 100,000 organizations and a vast partner ecosystem have relied on Commvault to reduce risks, improve governance, and do more with data. </p></div><p>Account Executive is responsible for achieving quota by selling solutions into a defined account list that may include current Commvault customers and high value prospects.  The position is a field sales role where the AE will engage in face-to-face sales with customers and prospects either directly or through partners. The Account Executive plans, organizes, leads and controls balanced sales growth, account penetration and customer satisfaction on a long-term multi-quarter basis. This individual may lead a cross-functional sales team and is responsible for creating sales campaigns to penetrate/expand his/her target accounts. The AE must have the ability to articulate an in-depth understanding of the customers’ environment, current challenges/goals and have the ability to align Commvault solutions to those challenges/goals including a financial and strategic value proposition.  The candidate must have a history of success in selling complex software platforms (vs. IT component or narrow focused tools) and should have some level of prior engagement with the target account set.</p>\n<p><strong>How you will make an impact:</strong></p>\n<ul>\n<li>Achieve quarterly and annual quotas by selling to new and established - large, complex prospects and customer.</li>\n<li>Develop and implement Strategic account plans for target account expansion and new account acquisition including performance objectives, financial targets, and critical milestones for a one and three-year period.</li>\n<li>Create sale campaigns into target accounts and closely coordinate company executive involvement with customer/prospect leadership.</li>\n<li>Coordinate the involvement of company personnel, including support, service, and management resources, in order to meet account performance objectives and customers’ expectations.</li>\n<li>Manage a matrixed sales team; liaison with clients, Deal Desk, inside sales, partners, channels, sales engineers, professional services, finance and legal to drive a prospect to close</li>\n<li>Establish and maintain a productive, professional relationship with key personnel in assigned customer/prospect accounts.</li>\n<li>Construct and deliver tangible business cases at the CXO level including financial (ROI &amp; TCO), technical and strategic value propositions</li>\n<li>Prepare and present sales proposals and presentations to new and existing clients</li>\n<li>Identify and build strategic relationships with partners and alliances that have existing relationships with the assigned target accounts</li>\n<li>Negotiate and close deals following the company’s practices and processes</li>\n<li>Ensure orders meet all legal and financial requirements</li>\n<li>Maintain a high level of relevant industry, Commvault and competitive knowledge</li>\n<li>Plan, attend and coordinate executive briefings</li>\n<li>Leverage internal sales tools and processes to drive opportunities to a successful close.</li>\n</ul>\n<p><strong>Position Requirements include:</strong></p>\n<ul>\n<li>Experience in identifying, building relationships and selling directly or with partners</li>\n<li>Excellent communication skills, persuasive, listening skills</li>\n<li>Background in IT infrastructure, security and SAAS</li>\n<li>Experience of MEDDICC sales methodology or similar would be an advantage</li>\n<li>Fluent German language skills</li>\n<li>Experience selling software solutions</li>\n</ul>\n<p> </p>\n<p>#LI-EL1</p>\n<p>#LI-remote</p><div><div>\n<p>Commvault is an equal opportunity workplace and is an affirmative action employer. We are always committed to equal employment opportunity regardless of race, color, ancestry, religion, sex, national origin, sexual orientation, age, citizenship, marital status, disability, gender identity or Veteran status and we will not discriminate against on the basis of such characteristics or any other status protected by the laws or regulations in the locations where we work.</p>\n<p>Commvault’s goal is to make interviewing inclusive and accessible to all candidates and employees. If you have a disability or special need that requires accommodation to participate in the interview process or apply for a position at Commvault, please email <span>accommodations@commvault.com</span> For any inquiries not related to an accommodation please reach out to <span>wwrecruitingteam@commvault.com</span>.</p>\n<p> </p>\n<p>Commvault&#39;s Privacy Policy </p>\n</div>\n<p> </p></div>",
  "countries": [
    "ch"
  ],
  "regions": [
    "eu"
  ],
  "skills": [
    "account-executive"
  ],
  "cities": [],
  "collections": [],
  "is_tech": "non_tech",
  "auto_apply_available": true,
  "posted_at": "2026-09-24T12:17:22Z",
  "created_at": "2026-07-13T14:57:23Z",
  "updated_at": "2026-09-24T14:11:38Z",
  "last_seen_at": "2026-09-24T14:11:38Z",
  "closed_at": null,
  "enrichment": {
    "experience_years_min": 25,
    "category": "sales",
    "posting_language": "en"
  },
  "enriched_at": null,
  "enrichment_version": 0,
  "view_count": 4,
  "applied_count": 0,
  "upvote_count": 0,
  "downvote_count": 0,
  "my_vote": 0,
  "reality": {
    "class": "stale",
    "age_days": 72,
    "repost_count": 1,
    "mass_posting_count": 1,
    "fake_freshness": false
  }
};

/** Eligible upstream (greenhouse), Netherlands, English-tagged. */
export const recordedEligibleNl: FreehireJob = {
  "public_slug": "technical-support-engineer-adyen-3xex3sdb",
  "source": "greenhouse",
  "manually_added": false,
  "external_id": "Adyen:7180929",
  "url": "https://job-boards.greenhouse.io/adyen/jobs/7180929?utm_source=freehire.me",
  "title": "Technical Support Engineer",
  "company": "Adyen",
  "company_slug": "adyen",
  "location": "Amsterdam",
  "description": "<p><strong>This is Adyen</strong></p>\n<p><span>Adyen provides payments, data, and financial products in a single solution for customers like Meta, Uber, H&amp;M, and Microsoft - making us the financial technology platform of choice. At Adyen, everything we do is engineered for ambition. </span></p>\n<p><span>For our teams, we create an environment with opportunities for our people to succeed, backed by the culture and support to ensure they are enabled to truly own their careers. We are motivated individuals who tackle unique technical challenges at scale and solve them as a team. Together, we deliver innovative and ethical solutions that help businesses achieve their ambitions faster.</span></p>\n<p><strong>Technical Support Engineer</strong></p>\n<p>You will operate as a first interface with Adyen’s merchants across the globe. As part of this role you will be working with teams across Adyen (technical and commercial). Your work will have a direct impact on our merchant’s ability to take payments and further grow their business. </p>\n<p>Our  team is extremely merchant-focused, highly motivated and thrives on shared success. You will be part of an international team with diverse backgrounds and skill sets. With Adyen being a 24/7 business we operate throughout time zones using a follow the sun principle.</p>\n<p>To support our merchants who process payments 24/7, this role occasionally requires participation in a planned, rotating schedule for weekend and holiday coverage. These hours will be compensated with time off as well as additional pay.</p>\n<p>The extensive payments knowledge of the team is the most valuable aspect both to our merchants as our internal teams.</p>\n<h4><strong>What you&#39;ll do </strong></h4>\n<ul>\n<li>Be a key source of knowledge on the Adyen platform and APIs, the underlying web-stack technologies, and industry-standard integration methods and best practices.</li>\n<li>You are responsible for supporting the merchants’ full lifecycle, providing direct technical support.</li>\n<li>Be an internal product advocate, track product processes and contribute to the platform feeding back feedback and issues you get back from merchants.</li>\n<li>Advising merchants regarding the best implementation practices and also addressing specific merchants’ issues.</li>\n</ul>\n<p><strong>Who you are</strong></p>\n<ul>\n<li>You recognise that each interaction with a merchant is a customer service experience. As such you aspire to deliver a seamless merchant support experience across the globe that transcends global boundaries and time. You have strong written and verbal communication skills in English</li>\n<li>You are innovative, have strong problem-solving capabilities and able to adapt to new processes and procedures quickly, while dealing with many varied technical support requests and challenges.</li>\n<li>You have affinity with API troubleshooting, Postman, internet technologies and knowledge of technical processes (think HTML / JavaScript  / Scripting). Technical skills related to Networks / Networking will also be considered an asset for the role.</li>\n<li>You are self-driven, flexible, and have the ability to maintain high levels of productivity with minimal supervision; taking accountability for your work and results delivered.</li>\n<li>You’ve had previous exposure to environments rich in uncertainty and you show a resulting track record of successfully dealing with ambiguity.</li>\n<li>You make quick informed decisions under pressure and prioritize appropriately based on urgency, necessity and both internal and external requests.</li>\n</ul>\n<p> </p>\n<p><strong>Our Diversity, Equity and Inclusion commitments </strong></p>\n<p><span>Our unique approach is a product of our diverse perspectives. This diversity of backgrounds and cultures is essential in helping us maintain our momentum. Our business and technical challenges are unique, and we need as many different voices as possible to join us in solving them - voices like yours. No matter who you are or where you’re from, we welcome you to be your true self at Adyen. </span></p>\n<p><span>Studies show that women and members of underrepresented communities apply for jobs only if they meet 100% of the qualifications. Does this sound like you? If so, Adyen encourages you to reconsider and apply. We look forward to your application!</span></p>\n<p><strong>What’s next?</strong></p>\n<p><span>Ensuring a smooth and enjoyable candidate experience is critical for us. We aim to get back to you regarding your application within 5 business days. Our interview process tends to take about 4 weeks to complete, but may fluctuate depending on the role. </span><span>Learn more about our hiring process here</span><span>. Don’t be afraid to let us know if you need more flexibility.</span></p>\n<p>This role is full time and based out of our Amsterdam office. We are an office-first company and value in-person collaboration (3 days a week in the office) ; we do not offer remote-only roles.</p>",
  "countries": [
    "nl"
  ],
  "regions": [
    "eu"
  ],
  "work_mode": "hybrid",
  "skills": [
    "api",
    "candidate-experience",
    "html",
    "javascript",
    "networking",
    "postman"
  ],
  "cities": [
    "Amsterdam"
  ],
  "collections": [
    "nl-recognised-sponsor"
  ],
  "is_tech": "non_tech",
  "auto_apply_available": true,
  "posted_at": "2026-09-24T14:07:01Z",
  "created_at": "2026-06-12T02:48:49Z",
  "updated_at": "2026-09-24T14:10:14Z",
  "last_seen_at": "2026-09-24T14:10:14Z",
  "closed_at": null,
  "enrichment": {
    "employment_type": "full_time",
    "category": "support",
    "domains": [
      "fintech"
    ],
    "posting_language": "en",
    "company_type": "product",
    "company_size": "1000+",
    "requirements": [
      {
        "text": "You recognise that each interaction with a merchant is a customer service experience. As such you aspire to deliver a seamless merchant support experience across the globe that transcends global bound",
        "priority": "required"
      },
      {
        "text": "You are innovative, have strong problem-solving capabilities and able to adapt to new processes and procedures quickly, while dealing with many varied technical support requests and challenges.",
        "priority": "required"
      },
      {
        "text": "You have affinity with API troubleshooting, Postman, internet technologies and knowledge of technical processes (think HTML / JavaScript / Scripting). Technical skills related to Networks / Networking",
        "priority": "required"
      },
      {
        "text": "You are self-driven, flexible, and have the ability to maintain high levels of productivity with minimal supervision; taking accountability for your work and results delivered.",
        "priority": "required"
      },
      {
        "text": "You’ve had previous exposure to environments rich in uncertainty and you show a resulting track record of successfully dealing with ambiguity.",
        "priority": "required"
      },
      {
        "text": "You make quick informed decisions under pressure and prioritize appropriately based on urgency, necessity and both internal and external requests.",
        "priority": "required"
      }
    ]
  },
  "enriched_at": "2026-06-12T20:36:38Z",
  "enrichment_version": 1,
  "view_count": 4,
  "applied_count": 0,
  "upvote_count": 0,
  "downvote_count": 0,
  "my_vote": 0,
  "reality": {
    "class": "stale",
    "age_days": 104,
    "repost_count": 2,
    "mass_posting_count": 1,
    "fake_freshness": true
  }
};

/** Ineligible upstream (smartrecruiters): well-formed but outside the allowlist. */
export const recordedIneligibleUpstream: FreehireJob = {
  "public_slug": "regulatory-data-digital-solutions-manager-sika-group-bcgzxajs",
  "source": "smartrecruiters",
  "manually_added": false,
  "external_id": "SikaAG:744000151603370",
  "url": "https://jobs.smartrecruiters.com/SikaAG/744000151603370-regulatory-data-digital-solutions-manager?utm_source=freehire.me",
  "title": "Regulatory Data & Digital Solutions Manager",
  "company": "Sika Group",
  "company_slug": "sika-group",
  "location": "Zürich, ZH, ch",
  "description": "<ul><li>Develop and drive the regulatory data strategy, target architecture, and capability roadmap</li><li>Translate regulatory requirements into structured data, metadata, traceability, retention, access, and reporting requirements</li><li>Define regulatory data objects, ownership models, quality standards, controls, and lifecycle governance</li><li>Collaborate with Product Conformity, Data Management, IT, Procurement, Supply Chain, Sustainability, and business stakeholders to identify and prioritize requirements</li><li>Coordinate solution design and integration across enterprise platforms such as SAP, PIM, EDMS, and related systems</li><li>Support packaging and supplier information management, Digital Product Passport (DPP) initiatives, and external information publication requirements</li><li>Establish and maintain a transparent regulatory data and digital solutions backlog</li><li>Design reusable data models, interfaces, and governance components for current and future regulatory frameworks</li><li>Prepare implementation roadmaps and transition plans while ensuring alignment with corporate Data and IT standards</li></ul><ul><li>Degree in Information Management, Computer Science, Engineering, Data Management, or a related field</li><li>Minimum 7 years of experience in data management, digital solutions, master data, product information, or business systems</li><li>Proven experience working with compliance-related, supplier, product, or packaging data</li><li>Strong understanding of data governance, information management, metadata, data quality, and lifecycle management</li><li>Experience translating business and regulatory requirements into scalable digital solutions and governance concepts</li><li>Familiarity with SAP, PIM, EDMS, DPP, or comparable product information and document management environments is highly desirable</li><li>Strong stakeholder management, communication, and influencing skills in a global matrix organization</li><li>Analytical, structured, and solution-oriented mindset with a high level of ownership</li><li>Fluent in English; German is considered an advantage</li></ul><ul><li>We offer competitive compensation packages, comprehensive benefits, and a supportive work environment that values diversity and inclusion. Join our team and be part of your journey to excellence!</li><li>Sika – Building Trust. Trust is the most important thing for us. We trust in the capabilities of all our Sika team members - every day.</li><li>Friendly, personable, and often surprisingly uncomplicated, that&#39;s how many of our employees describe their working relationship at Sika. We call this the Sika Spirit.</li><li>We offer an attractive employment package with good social benefits, excellent pension fund and accident insurance solutions </li></ul><p>We offer competitive salaries, aligned with local market benchmarks and the specific scope and responsibilities of each role. Compensation is determined based skills relevant to the position, education and/or training.  We are committed to fair and equitable pay practices in accordance with applicable laws and regulations.</p><div></div><p>We offer competitive salaries, aligned with local market benchmarks and the specific scope and responsibilities of each role. Compensation is determined based skills relevant to the position, education and/or training.  We are committed to fair and equitable pay practices in accordance with applicable laws and regulations.</p>",
  "countries": [
    "ch"
  ],
  "regions": [
    "eu"
  ],
  "work_mode": "hybrid",
  "skills": [
    "data-governance",
    "data-quality",
    "sap",
    "solution-design",
    "stakeholder-management"
  ],
  "cities": [
    "Zürich"
  ],
  "collections": [],
  "is_tech": "non_tech",
  "posted_at": "2026-09-24T12:16:46Z",
  "created_at": "2026-09-24T14:08:26Z",
  "updated_at": "2026-09-24T14:08:26Z",
  "last_seen_at": "2026-09-24T14:08:26Z",
  "closed_at": null,
  "enrichment": {
    "employment_type": "full_time",
    "seniority": "middle",
    "experience_years_min": 7,
    "english_level": "c1",
    "category": "management",
    "posting_language": "en"
  },
  "enriched_at": null,
  "enrichment_version": 0,
  "view_count": 0,
  "applied_count": 0,
  "upvote_count": 0,
  "downvote_count": 0,
  "my_vote": 0,
  "reality": {
    "class": "fresh",
    "age_days": 0,
    "repost_count": 1,
    "mass_posting_count": 1,
    "fake_freshness": false
  }
};
