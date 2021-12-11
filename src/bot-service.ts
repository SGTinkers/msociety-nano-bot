import { Bot, NextFunction } from "grammy";
import { convert, Unit } from "nanocurrency";
import { NyanoTipBotContext } from "./context";
import { BusinessErrors } from "./errors";
import { TipService } from "./tip-service";
import log from "loglevel";
import { User } from "@grammyjs/types";
import { TgUsernameMapperService } from "./tg-username-mapper-service";
import { Menu } from "@grammyjs/menu";

async function usernameRecorderMiddleware(ctx: NyanoTipBotContext, next: NextFunction) {
  const from = ctx.update.message?.from;
  if (from?.username) {
    await TgUsernameMapperService.put(from.username, from.id);
  }
  await next();
}

async function handleMessage(ctx: NyanoTipBotContext): Promise<void> {
  if (!ctx.update.message || !ctx.update.message.text) {
    return;
  }

  const text = " " + ctx.update?.message?.text + " ";
  const matchesOnStart = text?.match(/^ \/tip(\s[0-9]+(\.[0-9]+)?)? /);
  const matchesInBetween = text?.match(/ !tip(\s[0-9]+(\.[0-9]+)?)? /);
  const matches = matchesOnStart || matchesInBetween;
  const amountString =
    (((matchesOnStart && matchesOnStart[1]) ||
    (matchesInBetween && matchesInBetween[1])) ?? "10").trim();

  if (matches) {
    if (!ctx.update.message.from) {
      return;
    }

    if (ctx.update.message.from.is_bot) {
      return;
    }

    const from = ctx.update.message.from;
    const fromId = `${from.id}`;
    const mentionEntities =
      ctx.update.message.entities?.filter(entity => ['mention', 'text_mention'].includes(entity.type)) || [];

    if (
      (!ctx.update.message.reply_to_message ||
        !ctx.update.message.reply_to_message.from) &&
      mentionEntities.length !== 1
    ) {
      await ctx.reply("Reply to a message or mention a user to tip. Multiple mentions are not supported.");
      return;
    }

    let to: User;
    if (ctx.update.message.reply_to_message?.from) {
      to = ctx.update.message.reply_to_message.from;
    } else if (mentionEntities[0].type === "text_mention") {
      const entity = mentionEntities[0];
      to = entity.user;
    } else if (mentionEntities[0].type === "mention") {
      const entity = mentionEntities[0];
      const username = ctx.update.message.text.substr(entity.offset + 1, entity.length - 1);
      const userId = await TgUsernameMapperService.getId(username);
      if (!userId) {
        await ctx.reply("Unable to get recipient id, please try again by replying to recipient's message.");
        return;
      }

      try {
        const member = await ctx.getChatMember(userId);
        to = member.user;
      } catch (e) {
        log.error(e);
        await ctx.reply("Unable to get recipient id, please try again by replying to recipient's message.");
        return;
      }
    } else {
      await ctx.reply("Unable to get recipient id, please try again by replying to recipient's message.");
      return;
    }

    if (to.is_bot) {
      return;
    }

    if (from.id === to.id) {
      await ctx.reply("Try tipping other people instead.")
      return;
    }

    const toId = `${to.id}`;
    const amount = BigInt(convert(amountString, { from: Unit.nano, to: Unit.raw }));

    log.info(`${fromId} sending tip to ${toId}`);

    try {
      const msg = await ctx.reply(`Sending **${amountString.replace(/\./, "\\.")}** nyano to [${to.first_name}](tg://user?id=${to.id})\\.\\.\\.`, {
        parse_mode: "MarkdownV2",
        reply_to_message_id: ctx.update.message.message_id,
      });
      const url = await TipService.tipUser(fromId, toId, amount);
      await ctx.api.editMessageText(
        msg.chat.id,
        msg.message_id,
        `**[${amountString.replace(/\./, "\\.")}](${url})** nyano sent to [${
          to.first_name
        }](tg://user?id=${to.id})\\!`,
        {
          parse_mode: "MarkdownV2",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "What's this?",
                  url: `https://t.me/${ctx.me.username}?start`,
                },
              ],
            ],
          },
        }
      );
    } catch (e) {
      if (e === BusinessErrors.INSUFFICIENT_BALANCE) {
        await ctx.reply("Insufficient balance\\. Please top\\-up and try again\\.", {
          parse_mode: "MarkdownV2",
          reply_to_message_id: ctx.update.message.message_id,
          reply_markup: {
            inline_keyboard: [[{ text: "Top-up", url: `https://t.me/${ctx.me.username}?start=topup` }]],
          },
        });
      } else {
        throw e;
      }
    }
  }
}

async function getBlockExplorerUrl(ctx: NyanoTipBotContext): Promise<string> {
  if (!ctx.from) {
    throw new Error("From not found in context");
  }
  if (ctx.from.is_bot) {
    throw new Error("Trying to generate block explorer url for a bot");
  }
  const from = ctx.from;
  const fromId = `${from.id}`;
  return await TipService.getLinkForAccount(fromId);
}

async function getTopupUrl(ctx: NyanoTipBotContext): Promise<string> {
  if (!ctx.from) {
    throw new Error("From not found in context");
  }
  if (ctx.from.is_bot) {
    throw new Error("Trying to generate topup url for a bot");
  }
  const from = ctx.from;
  const fromId = `${from.id}`;
  return await TipService.getLinkForTopUp(fromId);
}

async function generateBalanceMessage(ctx: NyanoTipBotContext): Promise<string> {
  if (!ctx.from) {
    throw new Error("From not found in context");
  }
  if (ctx.from.is_bot) {
    throw new Error("Trying to generate topup url for a bot");
  }

  const from = ctx.from;
  const fromId = `${from.id}`;
  const account = await TipService.getAccount(fromId);
  const { balance, pending } = await TipService.getBalance(fromId);
  const balanceFormatted = convert(balance.toString(), {
    from: Unit.raw,
    to: Unit.nano,
  });
  const balanceFormattedNano = convert(balance.toString(), {
    from: Unit.raw,
    to: Unit.NANO,
  });
  const pendingFormatted = convert(pending.toString(), {
    from: Unit.raw,
    to: Unit.nano,
  });
  const pendingFormattedNano = convert(pending.toString(), {
    from: Unit.raw,
    to: Unit.NANO,
  });

  return `Balance: ${balanceFormatted} nyano (${balanceFormattedNano} NANO)\nPending: ${pendingFormatted} nyano (${pendingFormattedNano} NANO)\n\nAddress: ${account.address}`;
}

async function handleBalanceCommand(ctx: NyanoTipBotContext): Promise<void> {
  if (!ctx.from) {
    return;
  }

  if (ctx.from.is_bot) {
    return;
  }

  if (ctx.message && ctx.message.chat.type !== "private") {
    await ctx.reply(`DM me (@${ctx.me.username}) privately to check your balance.`)
    return;
  }

  log.info(`${ctx.from.id} requested /balance`);

  const text = await generateBalanceMessage(ctx);

  await ctx.reply(text, {
    reply_markup: accountBalanceMenu,
  })
}

async function withdrawBalance(ctx: NyanoTipBotContext): Promise<void> {
  if (!ctx.from) {
    return;
  }
  if (ctx.from.is_bot) {
    return;
  }

  if (ctx.message && ctx.message.chat.type !== "private") {
    await ctx.reply(`DM me (@${ctx.me.username}) privately to withdraw your balance.`)
    return;
  }

  await ctx.reply("We are still building this feature. Please try again later.");
}

async function handleStartCommand(ctx: NyanoTipBotContext) {
  if (!ctx.from) {
    return;
  }
  if (ctx.from.is_bot) {
    return;
  }

  if (ctx.message && ctx.message.chat.type !== "private") {
    return;
  }

  log.info(`${ctx.from.id} requested /start`);

  if (!ctx.match) {
    await ctx.reply(startText, { parse_mode: "MarkdownV2", reply_markup: startMenu });
  } else if (ctx.match === "topup") {
    await ctx.reply(await generateBalanceMessage(ctx), { reply_markup: accountBalanceMenu });
  }
}

function sendMessageOnTopUp(bot: Bot<NyanoTipBotContext>) {
  TipService.subscribeToOnReceiveBalance({
    onTip: async (fromTgUserId, toTgUserId) => {
      const { balance, pending } = await TipService.getBalance(toTgUserId);
      const balanceFormatted = convert(balance.toString(), {
        from: Unit.raw,
        to: Unit.nano,
      });
      const pendingFormatted = convert(pending.toString(), {
        from: Unit.raw,
        to: Unit.nano,
      });

      try {
        await bot.api.sendMessage(
          toTgUserId,
          `You just received a tip! New balance: ${balanceFormatted} nyano (Pending: ${pendingFormatted} nyano)`
        );
      } catch (e) {
        log.warn(e);
      }
    },
    onTopUp: async (tgUserId) => {
      const { balance, pending } = await TipService.getBalance(tgUserId);
      const balanceFormatted = convert(balance.toString(), {
        from: Unit.raw,
        to: Unit.nano,
      });
      const pendingFormatted = convert(pending.toString(), {
        from: Unit.raw,
        to: Unit.nano,
      });

      try {
        await bot.api.sendMessage(
          tgUserId,
          `Received top-up to balance! New balance: ${balanceFormatted} nyano (Pending: ${pendingFormatted} nyano)`
        );
      } catch (e) {
        log.warn(e);
      }
    }
  });
}

const startText = `[Nano](https://nano.org/) is a cryptocurrency that allows for instant and feeless payment\\. This makes it the perfect currency to tip others\\.

Ways to tip users\\:
1\\. Reply to their messages with \\"\\/tip \\<value\\>\\"
2\\. Tag the user and type \\"\\/tip \\<value\\>\\" in your message
3\\. Reply or tag user and include \\"\\!tip \\<value\\>\\" anywhere in your message

Note\\:
\\- The value is in Nyano \\(1 nyano \\= 0\\.000001 nano\\)
\\- If you do not specify the value\\, it will default to tip 10 Nyano

Have fun tipping\\!`;

const infoLedgerText = `Despite NyanoTipBot holding your balance\\, because Nano is a cryptocurrency\\, the ledger is transparent\\.
You can view your NyanoTipBot wallet on a block explorer website\\.

Likewise\\, for every tip that happens\\, it is an actual Nano transaction on\\-chain and you can view the transaction in the block explorer too\\.
`;

const startMenu: Menu = new Menu("start-menu")
  .submenu("Withdraw to personal wallet",  "submenu-with-back", (ctx) =>
    ctx.editMessageText("")
  )
  .row()
  .submenu("Track your tips journey",  "info-ledger-menu", (ctx) =>
    ctx.editMessageText(infoLedgerText, { parse_mode: "MarkdownV2" })
  )
  .row()
  .submenu("View account balance", "account-balance-menu", async (ctx) =>
    ctx.editMessageText(await generateBalanceMessage(ctx))
  )
  .row()
  .url("1 NANO = x SGD?", "https://www.coingecko.com/en/coins/nano/sgd");
const submenuWithBack: Menu = new Menu("submenu-with-back")
  .back("Back", (ctx) => ctx.editMessageText(startText, { parse_mode: "MarkdownV2" }));
const infoLedgerMenu: Menu = new Menu("info-ledger-menu")
  .dynamic(async (ctx, range) => {
    return range
      .url("My Account on Block Explorer", await getBlockExplorerUrl(ctx)).row()
      .back("Back", (ctx) => ctx.editMessageText(startText, { parse_mode: "MarkdownV2" }));
  });
const accountBalanceMenu: Menu = new Menu("account-balance-menu")
  .dynamic(async (ctx, range) => {
    return range
      .url("Top-up my tipping wallet", await getTopupUrl(ctx)).row()
      .url("My Account on Block Explorer", await getBlockExplorerUrl(ctx)).row()
      .back("Back", (ctx) => ctx.editMessageText(startText, { parse_mode: "MarkdownV2" }));
  });
startMenu.register(submenuWithBack);
startMenu.register(infoLedgerMenu);
startMenu.register(accountBalanceMenu);

export const BotService = {
  usernameRecorderMiddleware,
  handleMessage,
  handleBalanceCommand,
  handleStartCommand,
  withdrawBalance,
  sendMessageOnTopUp,
  startMenu,
};
