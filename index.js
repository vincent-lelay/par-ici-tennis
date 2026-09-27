import { chromium } from 'playwright'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { writeFileSync } from 'fs'
import { createEvent } from 'ics'
import { config } from './staticFiles.js'
import { notify } from './lib/ntfy.js'

dayjs.extend(customParseFormat)

const bookTennis = async () => {
  const DRY_RUN_MODE = process.argv.includes('--dry-run')

  if (DRY_RUN_MODE) {
    console.log('----- DRY RUN START -----')
    console.log(
      'Script lancé en mode DRY RUN. Afin de tester votre configuration, ' +
      'une recherche va être lancée mais AUCUNE réservation ne sera réalisée'
    )
  }

  console.log(`${dayjs().format()} - Starting searching tennis`)

  const browser = await chromium.launch({
    headless: true,
    slowMo: 0,
    timeout: 30000,
  })

  console.log(`${dayjs().format()} - Browser started`)

  const page = await browser.newPage()

  page.route(
    'https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captcha-invisible/invisible-captcha-infos',
    (route) => route.abort()
  )

  page.route(
    'https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captchas**',
    (route) => route.abort()
  )

  page.setDefaultTimeout(90000)

  await page.goto(
    'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1'
  )

  await page.click('#button_suivi_inscription')

  await page.fill(
    '#username',
    config?.account?.email || process.env.ACCOUNT_EMAIL
  )

  await page.fill(
    '#password',
    config?.account?.password || process.env.ACCOUNT_PASSWORD
  )

  await page.click('#form-login >> button')

  console.log(`${dayjs().format()} - User connected`)

  // Wait for login redirection before continuing
  await page.waitForSelector('.main-informations')

  try {
    const locations = !Array.isArray(config.locations)
      ? Object.keys(config.locations)
      : config.locations

    locationsLoop:
    for (const [i, location] of locations.entries()) {
      const logLocation = process.env.GITHUB_ACTIONS
        ? `location ${i + 1}`
        : location

      console.log(`${dayjs().format()} - Search at ${logLocation}`)

      await page.goto(
        'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!'
      )

      // ------------------------------------------------------------
      // Select tennis location
      // ------------------------------------------------------------

      await page
        .locator('.tokens-input-text')
        .pressSequentially(`${location} `)

      await page.waitForSelector(
        `.tokens-suggestions-list-element >> text="${location}"`
      )

      await page.click(
        `.tokens-suggestions-list-element >> text="${location}"`
      )

      // ------------------------------------------------------------
      // Select date
      // ------------------------------------------------------------

      await page.click('#when')

      const date = config.date
        ? dayjs(config.date, 'D/MM/YYYY')
        : dayjs().add(6, 'days')

      await page.waitForSelector(
        `[dateiso="${date.format('DD/MM/YYYY')}"]`
      )

      await page.click(
        `[dateiso="${date.format('DD/MM/YYYY')}"]`
      )

      await page.waitForSelector(
        '.date-picker',
        { state: 'hidden' }
      )

      // ------------------------------------------------------------
      // Search
      // ------------------------------------------------------------

      await page.click('#rechercher')

      // Wait until the results page is fully loaded
      await page.waitForLoadState('domcontentloaded')

      // ------------------------------------------------------------
      // Diagnostic: display every slot returned by the website
      // ------------------------------------------------------------

      const allSlots = await page.locator('[datedeb]').evaluateAll(
        elements =>
          elements.map(el => ({
            datedeb: el.getAttribute('datedeb'),
            courtid: el.getAttribute('courtid'),
          }))
      )

      console.log(
        `${dayjs().format()} - All returned slots (${allSlots.length}):`
      )

      for (const slot of allSlots) {
        console.log(
          `${dayjs().format()} - ` +
          `datedeb="${slot.datedeb}", ` +
          `courtid="${slot.courtid}"`
        )
      }

      // ------------------------------------------------------------
      // Search for a compatible slot
      // ------------------------------------------------------------

      let selectedHour
      let totalSlotsFound = 0
      let totalSlotsRejected = 0

      console.log(
        `${dayjs().format()} - Search parameters: ` +
        `location="${location}", ` +
        `date="${date.format('DD/MM/YYYY')}", ` +
        `hours=[${config.hours.join(', ')}], ` +
        `priceType=[${config.priceType.join(', ')}], ` +
        `courtType=[${config.courtType.join(', ')}]`
      )

      hoursLoop:
      for (const hour of config.hours) {
        const targetDateDeb =
          `${date.format('YYYY/MM/DD')} ${String(hour).padStart(2, '0')}:00:00`

        // IMPORTANT:
        // Do not use [datedeb="..."] directly to find the slots.
        // We retrieve every [datedeb] element and compare its attribute
        // value in JavaScript. This avoids the selector issue encountered
        // with the previous implementation.
        const allSlotElements = await page.locator('[datedeb]').all()

        const slots = []

        for (const slot of allSlotElements) {
          const slotDateDeb = await slot.getAttribute('datedeb')

          if (slotDateDeb === targetDateDeb) {
            slots.push(slot)
          }
        }

        console.log(
          `${dayjs().format()} - ` +
          `Hour ${hour}:00: ${slots.length} matching slot(s)`
        )

        totalSlotsFound += slots.length

        if (slots.length === 0) {
          continue
        }

        // ----------------------------------------------------------
        // Make sure the panel containing the slots is visible
        // ----------------------------------------------------------

        for (const slot of slots) {
          if (await slot.isVisible()) {
            break
          }

          const panelHeader = page.locator(
            `#head${location.replaceAll(' ', '')}${hour}h .panel-title`
          )

          if (await panelHeader.count()) {
            console.log(
              `${dayjs().format()} - ` +
              `Opening panel for ${hour}:00`
            )

            await panelHeader.click()
            break
          }
        }

        const courtNumbers =
          !Array.isArray(config.locations)
            ? (config.locations[location] || [])
            : []

        // ----------------------------------------------------------
        // Examine each candidate
        // ----------------------------------------------------------

        for (const slot of slots) {
          const courtId = await slot.getAttribute('courtid')

          console.log(
            `${dayjs().format()} - ` +
            `Inspecting candidate courtid=${courtId}, ` +
            `datedeb="${targetDateDeb}"`
          )

          // The slot belongs to a .row.tennis-court element.
          // Using XPath here avoids reconstructing a CSS selector
          // containing the datedeb attribute.
          const courtRow = slot.locator(
            'xpath=ancestor::*[' +
            'contains(concat(" ", normalize-space(@class), " "), " tennis-court ")' +
            '][1]'
          )

          if (await courtRow.count() === 0) {
            console.log(
              `${dayjs().format()} - ` +
              `Rejecting courtid=${courtId}: ` +
              `could not find tennis-court row`
            )

            totalSlotsRejected++
            continue
          }

          // --------------------------------------------------------
          // Court number filter
          // --------------------------------------------------------

          let courtName = 'unknown'

          const courtLocator = courtRow.locator('.court')

          if (await courtLocator.count()) {
            courtName = (
              await courtLocator.first().innerText()
            ).trim()
          }

          if (courtNumbers.length > 0) {
            const courtMatch = courtName.match(/Court N°(\d+)/)

            const courtNumber = courtMatch
              ? parseInt(courtMatch[1], 10)
              : NaN

            if (!courtNumbers.includes(courtNumber)) {
              console.log(
                `${dayjs().format()} - ` +
                `Rejecting courtid=${courtId}, ` +
                `court="${courtName}" ` +
                `because court number is not configured`
              )

              totalSlotsRejected++
              continue
            }
          }

          // --------------------------------------------------------
          // Price / court type
          // --------------------------------------------------------

          const priceDescriptionLocator =
            courtRow.locator('.price-description')

          if (await priceDescriptionLocator.count() === 0) {
            console.log(
              `${dayjs().format()} - ` +
              `Rejecting courtid=${courtId}: ` +
              `no .price-description found`
            )

            totalSlotsRejected++
            continue
          }

          const priceDescription =
            await priceDescriptionLocator.first().innerHTML()

          const priceParts = priceDescription
            .split(/<br\s*\/?>/i)
            .map(value =>
              value
                .replace(/<[^>]*>/g, '')
                .trim()
            )
            .filter(Boolean)

          const priceType = priceParts[0] || ''
          const courtType = priceParts[1] || ''

          console.log(
            `${dayjs().format()} - ` +
            `Candidate courtid=${courtId}, ` +
            `court="${courtName}", ` +
            `priceType="${priceType}", ` +
            `courtType="${courtType}"`
          )

          // --------------------------------------------------------
          // Apply configuration filters
          // --------------------------------------------------------

          const priceTypeMatches =
            config.priceType.includes(priceType)

          const courtTypeMatches =
            config.courtType.includes(courtType)

          if (!priceTypeMatches || !courtTypeMatches) {
            console.log(
              `${dayjs().format()} - ` +
              `Rejecting courtid=${courtId}: ` +
              `priceTypeMatches=${priceTypeMatches}, ` +
              `courtTypeMatches=${courtTypeMatches}`
            )

            totalSlotsRejected++
            continue
          }

          // --------------------------------------------------------
          // Slot accepted
          // --------------------------------------------------------

          console.log(
            `${dayjs().format()} - ` +
            `ACCEPTING courtid=${courtId} ` +
            `court="${courtName}" ` +
            `for ${hour}:00`
          )

          selectedHour = hour

          await slot.click()

          break hoursLoop
        }
      }

      console.log(
        `${dayjs().format()} - Search summary: ` +
        `${totalSlotsFound} slot(s) found, ` +
        `${totalSlotsRejected} rejected, ` +
        `selectedHour=${selectedHour ?? 'none'}, ` +
        `pageTitle="${await page.title()}"`
      )

      // ------------------------------------------------------------
      // Verify that we reached the reservation page
      // ------------------------------------------------------------

      if (await page.title() !== 'Paris | TENNIS - Reservation') {
        console.log(
          `${dayjs().format()} - ` +
          `Failed to find reservation for ${logLocation}`
        )

        continue
      }

      await page.waitForSelector(
        '.order-steps-infos h2 >> text="1 / 3 - Validation du court"'
      )

      // ------------------------------------------------------------
      // Players
      // ------------------------------------------------------------

      for (const [i, player] of config.players.entries()) {
        if (i > 0) {
          await page.click('.addPlayer')
        }

        await page.waitForSelector(
          `[name="player${i + 1}"]`
        )

        await page.fill(
          `[name="player${i + 1}"] >> nth=0`,
          player.lastName
        )

        await page.fill(
          `[name="player${i + 1}"] >> nth=1`,
          player.firstName
        )
      }

      await page.keyboard.press('Enter')

      // ------------------------------------------------------------
      // Payment
      // ------------------------------------------------------------

      console.log(
  `${dayjs().format()} - Reservation page reached`
)

console.log(
  `${dayjs().format()} - Page URL: ${page.url()}`
)

console.log(
  `${dayjs().format()} - Page title: ${await page.title()}`
)

console.log(
  `${dayjs().format()} - Forms:`,
  await page.locator('form').evaluateAll(forms =>
    forms.map(form => ({
      id: form.id,
      action: form.getAttribute('action'),
      className: form.className,
    }))
  )
)

console.log(
  `${dayjs().format()} - Selects:`,
  await page.locator('select').evaluateAll(selects =>
    selects.map(select => ({
      id: select.id,
      name: select.name,
      value: select.value,
      options: Array.from(select.options).map(option => ({
        value: option.value,
        text: option.textContent?.trim(),
      })),
    }))
  )
)

console.log(
  `${dayjs().format()} - Inputs:`,
  await page.locator('input').evaluateAll(inputs =>
    inputs.map(input => ({
      id: input.id,
      name: input.name,
      type: input.type,
      value: input.value,
    }))
  )
)

console.log(
  `${dayjs().format()} - Buttons:`,
  await page.locator('button, input[type="submit"], input[type="button"]')
    .evaluateAll(buttons =>
      buttons.map(button => ({
        id: button.id,
        name: button.getAttribute('name'),
        type: button.getAttribute('type'),
        text: button.textContent?.trim(),
        value: button.getAttribute('value'),
      }))
    )
)
      await page.waitForSelector(
        '#order_select_payment_form #paymentMode',
        { state: 'attached' }
      )

      const paymentMode =
        page.locator('#order_select_payment_form #paymentMode')

      await paymentMode.evaluate(el => {
        el.removeAttribute('readonly')
        el.style.display = 'block'
      })

      await paymentMode.fill('existingTicket')

      // ------------------------------------------------------------
      // Dry run
      // ------------------------------------------------------------

      if (DRY_RUN_MODE) {
        console.log(
          `${dayjs().format()} - ` +
          `Fausse réservation faite : ${logLocation}`
        )

        if (!process.env.GITHUB_ACTIONS) {
          console.log(
            `pour le ${date.format('YYYY/MM/DD')} à ${selectedHour}h`
          )
        }

        console.log('----- DRY RUN END -----')

        console.log(
          'Pour réellement réserver un créneau, ' +
          'relancez le script sans le paramètre --dry-run'
        )

        await page.click('#previous')
        await page.click('#btnCancelBooking')

        break locationsLoop
      }

      // ------------------------------------------------------------
      // Real reservation
      // ------------------------------------------------------------

      const submit =
        page.locator('#order_select_payment_form #envoyer')

      await submit.evaluate(el => {
        el.classList.remove('hide')
      })

      await submit.click()

      await page.waitForSelector('.confirmReservation')

      // ------------------------------------------------------------
      // Extract reservation details
      // ------------------------------------------------------------

      const address =
        (await page.locator('.address').textContent())
          .trim()
          .replace(/( ){2,}/g, ' ')

      const dateStr =
        (await page.locator('.date').textContent())
          .trim()
          .replace(/( ){2,}/g, ' ')

      const court =
        (await page.locator('.court').textContent())
          .trim()
          .replace(/( ){2,}/g, ' ')

      if (!process.env.GITHUB_ACTIONS) {
        console.log(
          `${dayjs().format()} - Réservation faite : ${address}`
        )

        console.log(`pour le ${dateStr}`)
        console.log(`sur le ${court}`)
      } else {
        console.log(
          'Réservation faite, regardez vos emails ou rendez-vous ' +
          'sur votre compte tennis.paris.fr pour plus de détails ' +
          'sur votre réservation.'
        )
      }

      // ------------------------------------------------------------
      // ICS
      // ------------------------------------------------------------

      const [day, month, year] = [
        date.date(),
        date.month() + 1,
        date.year(),
      ]

      const hourMatch = dateStr.match(/(\d{2})h/)
      const hour = hourMatch ? Number(hourMatch[1]) : 12

      const start = [
        year,
        month,
        day,
        hour,
        0,
      ]

      const duration = {
        hours: 1,
        minutes: 0,
      }

      const event = {
        start,
        duration,
        title: 'Réservation Tennis',
        description: `Court: ${court}\nAdresse: ${address}`,
        location: address,
        status: 'CONFIRMED',
      }

      const createdEvent = createEvent(event)

      if (createdEvent.error) {
        console.log(
          'ICS creation error:',
          createdEvent.error
        )

        break
      }

      const { value } = createdEvent

      if (!process.env.GITHUB_ACTIONS) {
        writeFileSync('event.ics', value)
      }

      // ------------------------------------------------------------
      // ntfy notification
      // ------------------------------------------------------------

      if (
        config.ntfy?.enable === true ||
        process.env.NTFY_TOPIC
      ) {
        await notify(
          Buffer.from(value, 'utf8'),
          'event.ics',
          `Confirmation pour le ${date.format('DD/MM/YYYY')} - ${hour}h`,
          {
            domain:
              config?.ntfy?.domain ||
              process.env.NTFY_DOMAIN,

            topic:
              config?.ntfy?.topic ||
              process.env.NTFY_TOPIC,
          }
        )
      }

      break
    }
  } catch (e) {
    console.log(e)

    await page.screenshot({
      path: 'img/failure.png',
    })

    if (
      config.ntfy?.enable === true ||
      process.env.NTFY_TOPIC
    ) {
      await notify(
        await page.screenshot(),
        'failure.png',
        "Erreur lors de l'execution du programme.",
        {
          domain:
            config?.ntfy?.domain ||
            process.env.NTFY_DOMAIN,

          topic:
            config?.ntfy?.topic ||
            process.env.NTFY_TOPIC,
        }
      )
    }
  }

  await browser.close()
}

bookTennis()
